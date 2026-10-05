// Shared fixture for the `submit_attestation` test files: one surfnet with the
// oracle, SAS, its credential and schema, and a registered enclave key.
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  generateKeyPairSigner,
  isSolanaError,
} from '@solana/kit';
import { fetchConfig, findConfigPda } from '@tio/oracle-client';
import {
  type EnclaveKey,
  type PayloadFields,
  type SubmitParams,
  type Submission,
  buildPayload,
  buildSubmission,
  attestationAddress,
  enclaveKey,
  fetchRaw,
  freshClock,
} from './attest.ts';
import {
  type Harness,
  KIND_OYSTER_IMAGE_ID,
  findCustomErrorCode,
  initializeOracle,
  registerIx,
  revokeIx,
  send,
  startHarness,
  validEnclave,
} from './harness.ts';

export type Fixture = {
  h: Harness;
  relayer: KeyPairSigner;
  credential: Address;
  schema: Address;
  /** The enclave key registered at `entryId` (kind 1, Oyster). */
  key: EnclaveKey;
  entryId: number;
};

let nextSeed = 1;
/** A key nobody has registered yet (distinct seed per call). */
export function freshKey(): EnclaveKey {
  nextSeed += 1;
  return enclaveKey(nextSeed);
}

async function nextMeasurementId(h: Harness): Promise<number> {
  const [config] = await findConfigPda();
  return (await fetchConfig(h.rpc, config)).data.nextMeasurementId;
}

/** Registers `key` as a new enclave entry and returns its measurement id. */
export async function registerKey(
  h: Harness,
  key: EnclaveKey,
  measurementKind = KIND_OYSTER_IMAGE_ID,
): Promise<number> {
  const id = await nextMeasurementId(h);
  const measurement = new Uint8Array(32).fill(id + 1);
  const args = validEnclave({ measurementKind, measurement, attester: key.ethAddress });
  await send(h, h.admin, [await registerIx(h, id, args)]);
  return id;
}

export async function revokeEntry(h: Harness, id: number): Promise<void> {
  await send(h, h.admin, [await revokeIx(h, id)]);
}

/** Surfnet with oracle (initialized), SAS + credential + schema, and one registered enclave. */
export async function startFixture(): Promise<Fixture> {
  const h = await startHarness({ sas: true });
  if (h.sas === undefined) {
    throw new Error('harness did not set up SAS');
  }
  await initializeOracle(h);
  const key = freshKey();
  const entryId = await registerKey(h, key);
  return {
    h,
    relayer: h.attacker,
    credential: h.sas.credential,
    schema: h.sas.schema,
    key,
    entryId,
  };
}

export type Case = {
  now: bigint;
  wallet: Address;
  params: SubmitParams;
};

/**
 * A fresh clock era, a fresh wallet and valid params: payload issued at `now`,
 * signed by the fixture's registered key for the fixture's entry.
 */
export async function newCase(
  f: Fixture,
  overrides: {
    /** Reuse this clock reading instead of jumping to a fresh era (the clock must already be there). */
    now?: bigint;
    issuedAtOffset?: bigint;
    payload?: Partial<Omit<PayloadFields, 'issuedAt'>>;
    key?: EnclaveKey;
    entryId?: number;
    wallet?: Address;
    expiry?: bigint;
    params?: Partial<SubmitParams>;
  } = {},
): Promise<Case> {
  const now = overrides.now ?? (await freshClock(f.h));
  const wallet = overrides.wallet ?? (await generateKeyPairSigner()).address;
  const issuedAt = now + (overrides.issuedAtOffset ?? 0n);
  const entryId = overrides.entryId ?? f.entryId;
  const payload = buildPayload({ measurementId: entryId, ...overrides.payload, issuedAt });
  const params: SubmitParams = {
    relayer: f.relayer,
    key: overrides.key ?? f.key,
    entryId,
    wallet,
    credential: f.credential,
    schema: f.schema,
    payload,
    ...(overrides.expiry === undefined ? {} : { expiry: overrides.expiry }),
    ...overrides.params,
  };
  return { now, wallet, params };
}

/** The attestation PDA for a case's wallet. */
export function attestationOf(f: Fixture, wallet: Address): Promise<Address> {
  return attestationAddress(f.credential, f.schema, wallet);
}

/** Precompile + oracle instructions for `params`. */
export async function instructionsFor(f: Fixture, params: SubmitParams): Promise<Submission> {
  return buildSubmission(f.h, params);
}

/** Sends `[precompile, oracle]` (precompile lands at index 1 behind the harness compute-budget ix). */
export async function submit(f: Fixture, params: SubmitParams): Promise<string> {
  const s = await buildSubmission(f.h, params);
  return send(f.h, params.relayer, [s.precompile, s.oracle]);
}

export type Failure = { error: unknown; code: number | undefined };

/** Sends and returns the failure; throws if the transaction succeeds. */
export async function sendExpectingFailure(
  f: Fixture,
  signer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<Failure> {
  try {
    await send(f.h, signer, instructions);
  } catch (error) {
    return { error, code: findCustomErrorCode(error) };
  }
  throw new Error('transaction succeeded, expected a failure');
}

/** Submits and returns the failure (custom code, if any). */
export async function submitExpectingFailure(f: Fixture, params: SubmitParams): Promise<Failure> {
  const s = await buildSubmission(f.h, params);
  return sendExpectingFailure(f, params.relayer, [s.precompile, s.oracle]);
}

/** Index of the failing instruction for a custom error, if the error carries one. */
export function failingInstructionIndex(error: unknown): number | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (isSolanaError(current, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
      return current.context.index;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export async function attestationExists(f: Fixture, wallet: Address): Promise<boolean> {
  return (await fetchRaw(f.h, await attestationOf(f, wallet))) !== undefined;
}
