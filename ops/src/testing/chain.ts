// Test code only. Boots an embedded surfnet with the oracle, the demo pool and the dumped SAS
// binary, and gives the surfpool suites a few chain helpers. `@tio/oracle-tests` has similar
// helpers but depends on `@tio/ops`, so ops cannot import it (cycle).
import { fileURLToPath } from 'node:url';
import { fetchToken } from '@solana-program/token';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  isSolanaError,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { Surfnet } from '@solana/surfpool';
import { DEMO_POOL_PROGRAM_ADDRESS } from '@tio/demo-pool-client';
import { ORACLE_PROGRAM_ADDRESS, getInitializeInstructionAsync } from '@tio/oracle-client';
import { SAS_PROGRAM_ID, SAS_SO_PATH } from '../sas-schema.ts';

export const ORACLE_SO_PATH = fileURLToPath(
  new URL('../../../target/deploy/oracle.so', import.meta.url),
);
export const DEMO_POOL_SO_PATH = fileURLToPath(
  new URL('../../../target/deploy/demo_pool.so', import.meta.url),
);

const BPF_LOADER_UPGRADEABLE = address('BPFLoaderUpgradeab1e11111111111111111111111');
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Custom error code the oracle returns when the signer isn't the program's upgrade authority. */
export const ORACLE_NOT_UPGRADE_AUTHORITY = 6000;

export type OpsChain = {
  surfnet: Surfnet;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** Surfnet-funded account. */
  payer: KeyPairSigner;
  /** Oracle upgrade authority: the only key that may `initialize`. */
  upgradeAuthority: KeyPairSigner;
  /** Funded; becomes the oracle admin and the pool admin in the suites. */
  admin: KeyPairSigner;
  /** Funded signer that is neither of the above. */
  outsider: KeyPairSigner;
};

/**
 * Fresh surfnet with oracle, demo pool and SAS deployed. The oracle's upgrade authority is
 * `chain.upgradeAuthority`. Nothing is initialized: no oracle config, no SAS credential.
 */
export async function startOpsChain(): Promise<OpsChain> {
  const surfnet = Surfnet.start();
  surfnet.deploy({ programId: ORACLE_PROGRAM_ADDRESS, soPath: ORACLE_SO_PATH });
  surfnet.deploy({ programId: DEMO_POOL_PROGRAM_ADDRESS, soPath: DEMO_POOL_SO_PATH });
  surfnet.deploy({ programId: SAS_PROGRAM_ID, soPath: SAS_SO_PATH });
  const chain: OpsChain = {
    surfnet,
    rpc: createSolanaRpc(surfnet.rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(surfnet.wsUrl),
    payer: await createKeyPairSignerFromBytes(surfnet.payerSecretKey),
    upgradeAuthority: await generateKeyPairSigner(),
    admin: await generateKeyPairSigner(),
    outsider: await generateKeyPairSigner(),
  };
  for (const signer of [chain.upgradeAuthority, chain.admin, chain.outsider]) {
    surfnet.fundSol(signer.address, 100 * LAMPORTS_PER_SOL);
  }
  await setUpgradeAuthority(chain, ORACLE_PROGRAM_ADDRESS, chain.upgradeAuthority.address);
  return chain;
}

export async function setUpgradeAuthority(
  chain: OpsChain,
  programId: Address,
  newAuthority: Address,
): Promise<void> {
  const response = await fetch(chain.surfnet.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'surfnet_setProgramAuthority',
      params: [programId, newAuthority],
    }),
  });
  const body: unknown = await response.json();
  if (typeof body === 'object' && body !== null && 'error' in body) {
    throw new Error(`surfnet_setProgramAuthority failed: ${JSON.stringify(body.error)}`);
  }
}

export async function programDataAddress(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE,
    seeds: [getAddressEncoder().encode(programId)],
  });
  return pda;
}

/** Initializes the oracle config directly (not through ops code) with `chain.admin` as admin. */
export async function initializeOracleDirect(chain: OpsChain): Promise<void> {
  const instruction = await getInitializeInstructionAsync({
    authority: chain.upgradeAuthority,
    programData: await programDataAddress(ORACLE_PROGRAM_ADDRESS),
    admin: chain.admin.address,
  });
  await send(chain, chain.upgradeAuthority, [instruction]);
}

/** Sends and confirms one transaction. Rejects with the cluster's error on failure. */
export async function send(
  chain: Pick<OpsChain, 'rpc' | 'rpcSubscriptions'>,
  signer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<void> {
  const { value: blockhash } = await chain.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(transaction);
  await sendAndConfirmTransactionFactory({
    rpc: chain.rpc,
    rpcSubscriptions: chain.rpcSubscriptions,
  })(transaction, { commitment: 'confirmed' });
}

/** The first custom program error code in an error's cause chain, if any. */
export function findCustomErrorCode(error: unknown): number | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (isSolanaError(current, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
      return current.context.code;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/** What a promise rejected with, or undefined if it resolved. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/**
 * The same RPC with every `sendTransaction` counted, to assert that a re-run (or a failed
 * precondition) sends nothing.
 */
export function countingRpc(rpc: Rpc<SolanaRpcApi>): {
  rpc: Rpc<SolanaRpcApi>;
  sent: () => number;
} {
  let count = 0;
  const counted = new Proxy(rpc, {
    get(target, property, receiver) {
      if (property === 'sendTransaction') {
        return (...args: Parameters<Rpc<SolanaRpcApi>['sendTransaction']>) => {
          count += 1;
          return target.sendTransaction(...args);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return { rpc: counted, sent: () => count };
}

export async function tokenBalance(rpc: Rpc<SolanaRpcApi>, tokenAccount: Address): Promise<bigint> {
  return (await fetchToken(rpc, tokenAccount)).data.amount;
}
