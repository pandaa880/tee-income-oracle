/**
 * Relays the enclave's signed result on chain (FORMATS §8, §13): one v0
 * transaction `[compute-unit limit, secp256k1 precompile, submit_attestation]`
 * paid by the relayer. The program checks the enclave signature, not the
 * payer, so the relayer can only pay or not pay.
 *
 * Idempotent: the oracle needs a strictly newer `issued_at` per wallet, so the
 * same result can never land twice, and re-signing after an expired blockhash
 * (one fresh attempt) can't double-spend (Solana "Retrying Transactions"
 * guide). After a failed send we first check our OWN signatures: one that
 * landed is the answer. Otherwise, if the attestation already stores our
 * payload (a duplicate refused with 6026), it's a success with `tx: null`:
 * the address history can't tell us which transaction wrote it (it also lists
 * failed and unrelated transactions, e.g. a borrow).
 */
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getSignatureFromTransaction,
  isSolanaError,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  ORACLE_PROGRAM_ID,
  SAS_PROGRAM_ID,
  attestationAddress,
  buildMessage,
  buildPrecompileData,
  parseSasAttestation,
  precompileInstruction,
} from '@tio/oracle-client/attest';
import { findEnclaveEntryPda, getSubmitAttestationInstructionAsync } from '@tio/oracle-client';

import { fromHex } from '@tio/encoding';
import type { Chain } from './chain.ts';
import type { Deployment } from './config.ts';
import { GatewayError, gatewayError } from './errors.ts';
import type { Relayer } from './flow.ts';
import { entryFromAccount } from './registry.ts';

export const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
const ENCLAVE_REVOKED = 6019;
const STALE_ATTESTATION = 6026;
/** Measured: 22,968 CU for a refresh; the precompile itself costs no CU. */
const DEFAULT_COMPUTE_UNITS = 60_000;

/** ComputeBudget `SetComputeUnitLimit(units)`: tag 2 then u32 LE. */
function computeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data };
}

function customErrorCode(error: unknown): number | undefined {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return e.context.code;
  }
  return undefined;
}

export type RelayerOptions = {
  chain: Chain;
  payer: KeyPairSigner;
  deployment: Deployment;
  measurementId: number;
  computeUnits?: number;
};

type Ctx = RelayerOptions & {
  credential: Address;
  schema: Address;
  /**
   * The attester (eth address) of our registry entry, read on every submit: an entry
   * revoked while the gateway runs must stop relaying at once, with a clear code.
   */
  attester: () => Promise<Uint8Array>;
};

type Submission = { wallet: Address; payload: Uint8Array; signature: Uint8Array; expiry: bigint };

async function buildInstructions(
  ctx: Ctx,
  s: Submission,
  attestation: Address,
): Promise<Instruction[]> {
  const { credential, schema, payer, measurementId } = ctx;
  const message = buildMessage({ programId: ORACLE_PROGRAM_ID, credential, schema, ...s });
  const data = buildPrecompileData({
    ethAddress: await ctx.attester(),
    signature: s.signature,
    message,
    index: 1, // after the compute-budget instruction
  });
  return [
    computeUnitLimit(ctx.computeUnits ?? DEFAULT_COMPUTE_UNITS),
    precompileInstruction(data),
    await getSubmitAttestationInstructionAsync({
      payer,
      credential,
      schema,
      attestation,
      enclaveEntry: (await findEnclaveEntryPda({ measurementId }))[0],
    }),
  ];
}

/** Signs a fresh-blockhash transaction; the signature is known before sending. */
async function signTransaction(ctx: Ctx, ixs: Instruction[]) {
  const blockhash = await ctx.chain.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(ctx.payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(tx);
  return { tx, signature: getSignatureFromTransaction(tx) };
}

/** The first of our own signatures that landed without error, if any. */
async function ownLanded(ctx: Ctx, sent: Signature[]): Promise<Signature | undefined> {
  const statuses = await ctx.chain.signatureStatuses(sent);
  return sent.find((_, i) => {
    const status = statuses[i];
    // Only a definite `confirmed`/`finalized` counts; `processed` or an unknown (null) status
    // falls through to the stored-payload check.
    const settled =
      status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized';
    return settled && status?.err === null;
  });
}

/** Whether the attestation account already stores exactly `payload`. */
async function storesPayload(
  ctx: Ctx,
  attestation: Address,
  payload: Uint8Array,
): Promise<boolean> {
  const account = await ctx.chain.account(attestation);
  if (account === null) return false;
  const stored = parseSasAttestation(account.owner, account.data);
  return Buffer.from(stored.payload).equals(Buffer.from(payload));
}

async function submit(
  ctx: Ctx,
  s: Submission,
): Promise<{ tx: string | null; attestation: string }> {
  const attestation = await attestationAddress(ctx.credential, ctx.schema, s.wallet);
  // Chain reads (the registry entry) fail as chain errors, never internal_error.
  const ixs = await buildInstructions(ctx, s, attestation).catch((error: unknown) => {
    throw error instanceof GatewayError ? error : gatewayError('tx_failed', 'chain', 502);
  });
  const sent: Signature[] = [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { tx, signature } = await signTransaction(ctx, ixs);
      sent.push(signature);
      await ctx.chain.sendAndConfirm(tx);
      return { tx: signature, attestation };
    } catch (error) {
      const own = sent.length === 0 ? undefined : await ownLanded(ctx, sent).catch(() => undefined);
      if (own !== undefined) return { tx: own, attestation };
      if (await storesPayload(ctx, attestation, s.payload).catch(() => false)) {
        return { tx: null, attestation };
      }
      const code = customErrorCode(error);
      if (code === STALE_ATTESTATION) throw gatewayError('stale_attestation', 'chain', 409);
      // Revoked between our registry read and the send (or the retry).
      if (code === ENCLAVE_REVOKED) throw gatewayError('enclave_revoked', 'chain', 503);
      if (attempt === 0 && isSolanaError(error, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED)) continue;
      throw gatewayError('tx_failed', 'chain', 502);
    }
  }
}

export function createRelayer(opts: RelayerOptions): Relayer {
  const { chain, deployment, measurementId } = opts;
  // The instruction builders compile in the program ids; refuse a deployment that differs.
  if (deployment.oracleProgram !== ORACLE_PROGRAM_ID || deployment.sasProgram !== SAS_PROGRAM_ID) {
    throw new Error('deployment program ids differ from @tio/oracle-client/attest');
  }
  const ctx: Ctx = {
    ...opts,
    credential: address(deployment.credential),
    schema: address(deployment.schema),
    attester: async () => {
      const [entryAddress] = await findEnclaveEntryPda({ measurementId });
      const entry = entryFromAccount(await chain.account(entryAddress));
      if (entry === undefined) throw gatewayError('enclave_not_registered', 'chain', 503);
      if (entry.revokedAt !== 0n) throw gatewayError('enclave_revoked', 'chain', 503);
      return Uint8Array.from(entry.attester);
    },
  };
  return {
    submit: (a) =>
      submit(ctx, {
        wallet: address(a.wallet),
        payload: fromHex(a.payloadHex),
        signature: fromHex(a.signatureHex),
        expiry: BigInt(a.expiry),
      }),
  };
}
