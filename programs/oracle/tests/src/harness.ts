import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  signature as toSignature,
  address as toAddress,
  isSolanaError,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { Surfnet } from '@solana/surfpool';
import {
  ORACLE_PROGRAM_ADDRESS,
  findConfigPda,
  findEnclaveEntryPda,
  getInitializeInstructionAsync,
  getRegisterEnclaveInstruction,
  getRevokeEnclaveInstruction,
} from '@tio/oracle-client';
import { fileURLToPath } from 'node:url';

export const ORACLE_SO_PATH = fileURLToPath(
  new URL('../../../../target/deploy/oracle.so', import.meta.url),
);
const BPF_LOADER_UPGRADEABLE = toAddress('BPFLoaderUpgradeab1e11111111111111111111111');
const COMPUTE_BUDGET = toAddress('ComputeBudget111111111111111111111111111111');
const LAMPORTS_PER_SOL = 1_000_000_000;

// Anchor framework error: account not initialized.
export const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012;
export const ANCHOR_CONSTRAINT_SEEDS = 2006;
// System program error: account already in use.
export const SYSTEM_ACCOUNT_ALREADY_IN_USE = 0;

export const KIND_OYSTER_IMAGE_ID = 1;
export const KIND_AWS_PCR0 = 2;

export type Harness = {
  surfnet: Surfnet;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** Surfnet-funded account; used where the fee payer is not an oracle role. */
  payer: KeyPairSigner;
  upgradeAuthority: KeyPairSigner;
  admin: KeyPairSigner;
  attacker: KeyPairSigner;
  sendCount: number;
};

export async function programDataAddress(programId: Address): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE,
    seeds: [getAddressEncoder().encode(programId)],
  });
  return address;
}

export async function setUpgradeAuthority(
  harness: Harness,
  programId: Address,
  newAuthority: Address,
): Promise<void> {
  const response = await fetch(harness.surfnet.rpcUrl, {
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

/** Fresh surfnet with the oracle deployed and `upgradeAuthority` as its upgrade authority. */
export async function startHarness(): Promise<Harness> {
  const surfnet = Surfnet.start();
  surfnet.deploy({ programId: ORACLE_PROGRAM_ADDRESS, soPath: ORACLE_SO_PATH });
  const harness: Harness = {
    surfnet,
    rpc: createSolanaRpc(surfnet.rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(surfnet.wsUrl),
    payer: await createKeyPairSignerFromBytes(surfnet.payerSecretKey),
    upgradeAuthority: await generateKeyPairSigner(),
    admin: await generateKeyPairSigner(),
    attacker: await generateKeyPairSigner(),
    sendCount: 0,
  };
  for (const signer of [harness.upgradeAuthority, harness.admin, harness.attacker]) {
    surfnet.fundSol(signer.address, 100 * LAMPORTS_PER_SOL);
  }
  await setUpgradeAuthority(harness, ORACLE_PROGRAM_ADDRESS, harness.upgradeAuthority.address);
  return harness;
}

// A unique compute-limit instruction keeps otherwise identical transactions from deduplicating.
function uniqueComputeLimit(harness: Harness): Instruction {
  harness.sendCount += 1;
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit
  new DataView(data.buffer).setUint32(1, 1_000_000 + harness.sendCount, true);
  return { programAddress: COMPUTE_BUDGET, data };
}

/** Sends and confirms; returns the signature. Rejects with the cluster's error on failure. */
export async function send(
  harness: Harness,
  signer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<string> {
  const { value: blockhash } = await harness.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([uniqueComputeLimit(harness), ...instructions], m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(transaction);
  await sendAndConfirmTransactionFactory({
    rpc: harness.rpc,
    rpcSubscriptions: harness.rpcSubscriptions,
  })(transaction, { commitment: 'confirmed' });
  return getSignatureFromTransaction(transaction);
}

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

/** Sends and returns the custom program error code, or undefined if the tx succeeded. */
export async function sendExpectingCustomError(
  harness: Harness,
  signer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<number | undefined> {
  try {
    await send(harness, signer, instructions);
  } catch (error) {
    const code = findCustomErrorCode(error);
    if (code === undefined) {
      throw error;
    }
    return code;
  }
  return undefined;
}

/** Raw bytes of every `Program data:` log line (Anchor `emit!`) of a confirmed transaction. */
export async function eventPayloads(harness: Harness, signature: string): Promise<Uint8Array[]> {
  const prefix = 'Program data: ';
  const tx = await harness.rpc
    .getTransaction(toSignature(signature), {
      commitment: 'confirmed',
      encoding: 'json',
      maxSupportedTransactionVersion: 0,
    })
    .send();
  return (tx?.meta?.logMessages ?? [])
    .filter((line) => line.startsWith(prefix))
    .map((line) => new Uint8Array(getBase64Encoder().encode(line.slice(prefix.length))));
}

export function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

export type EnclaveArgs = {
  measurementKind: number;
  measurement: Uint8Array;
  attester: Uint8Array;
  attestationDocHash: Uint8Array;
};

export function validEnclave(overrides: Partial<EnclaveArgs> = {}): EnclaveArgs {
  return {
    measurementKind: KIND_OYSTER_IMAGE_ID,
    measurement: bytes(32, 0xaa),
    attester: bytes(20, 0xbb),
    attestationDocHash: bytes(32, 0xcc),
    ...overrides,
  };
}

export async function initializeIx(
  harness: Harness,
  authority?: KeyPairSigner,
  programData?: Address,
  admin?: Address,
) {
  return getInitializeInstructionAsync({
    authority: authority ?? harness.upgradeAuthority,
    programData: programData ?? (await programDataAddress(ORACLE_PROGRAM_ADDRESS)),
    admin: admin ?? harness.admin.address,
  });
}

export async function initializeOracle(harness: Harness): Promise<void> {
  await send(harness, harness.upgradeAuthority, [await initializeIx(harness)]);
}

export async function registerIx(
  harness: Harness,
  id: number,
  args: EnclaveArgs = validEnclave(),
  signer?: KeyPairSigner,
) {
  const [config] = await findConfigPda();
  const [enclaveEntry] = await findEnclaveEntryPda({ measurementId: id });
  return getRegisterEnclaveInstruction({
    admin: signer ?? harness.admin,
    config,
    enclaveEntry,
    ...args,
  });
}

export async function revokeIx(harness: Harness, id: number, signer?: KeyPairSigner) {
  const [config] = await findConfigPda();
  const [enclaveEntry] = await findEnclaveEntryPda({ measurementId: id });
  return getRevokeEnclaveInstruction({
    admin: signer ?? harness.admin,
    config,
    enclaveEntry,
    measurementId: id,
  });
}
