// Test helpers for `submit_attestation`: the FORMATS §7 payload and §8 signed
// message (byte-exact, built here independently of the program), secp256k1
// signing, the secp256k1 precompile instruction, SAS account readers and the
// surfpool clock cheatcode.
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from '@solana/kit';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { SAS_PROGRAM_ID } from '@tio/ops/sas-schema';
import {
  ORACLE_PROGRAM_ADDRESS,
  findEnclaveEntryPda,
  getSubmitAttestationInstructionAsync,
} from '@tio/oracle-client';
import { type Harness } from './harness.ts';

export { SAS_PROGRAM_ID };

export const SECP256K1_PROGRAM = address('KeccakSecp256k11111111111111111111111111111');
const CLOCK_SYSVAR = address('SysvarC1ock11111111111111111111111111111111');
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

export const DOMAIN_TAG = 'TIO-ATTEST-v1';
export const PAYLOAD_LEN = 83;
export const MESSAGE_LEN = 232;
export const PRECOMPILE_DATA_LEN = 329;
export const SAS_ATTESTATION_LEN = 256;
export const SAS_ATTESTATION_DISCRIMINATOR = 2;
export const MAX_SKEW_SECS = 300n;
export const MAX_SIGNATURE_LIFETIME_SECS = 600n;
export const ATTESTATION_TTL_SECS = 30n * 86_400n;

// Byte offsets inside the SAS attestation account (256 bytes).
const SAS_NONCE_OFFSET = 1;
const SAS_CREDENTIAL_OFFSET = 33;
const SAS_SCHEMA_OFFSET = 65;
const SAS_DATA_LEN_OFFSET = 97;
const SAS_DATA_OFFSET = 101;
const SAS_SIGNER_OFFSET = 184;
const SAS_EXPIRY_OFFSET = 216;

// --- keys -------------------------------------------------------------

export type EnclaveKey = { secretKey: Uint8Array; ethAddress: Uint8Array };

/** Eth address: last 20 bytes of keccak256 of the uncompressed public key without its 0x04 prefix. */
export function ethAddressOf(secretKey: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.getPublicKey(secretKey, false);
  return keccak_256(uncompressed.subarray(1)).subarray(12);
}

/** A deterministic test key: 32 bytes of `seed` (1..255). */
export function enclaveKey(seed: number): EnclaveKey {
  const secretKey = new Uint8Array(32).fill(seed);
  return { secretKey, ethAddress: ethAddressOf(secretKey) };
}

/** `r ‖ s ‖ v` (65 bytes) over keccak256(message), low-S, v in {0,1}. */
export function signMessage(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  const hash = keccak_256(message);
  const recovered = secp256k1.sign(hash, secretKey, {
    prehash: false,
    format: 'recovered',
    lowS: true,
  });
  // noble 2.x returns the recovery byte first: [v, r, s].
  const v = recovered[0];
  if (recovered.length !== 65 || v === undefined || v > 1) {
    throw new Error('unexpected recovered-signature layout from noble');
  }
  const out = new Uint8Array(65);
  out.set(recovered.subarray(1), 0);
  out[64] = v;
  return out;
}

/** The eth address recovered from `r ‖ s ‖ v` over keccak256(message). */
export function recoverEthAddress(signature: Uint8Array, message: Uint8Array): Uint8Array {
  const reordered = new Uint8Array(65);
  reordered[0] = signature[64] ?? 0;
  reordered.set(signature.subarray(0, 64), 1);
  const pub = secp256k1.recoverPublicKey(reordered, keccak_256(message), { prehash: false });
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
  return keccak_256(uncompressed.subarray(1)).subarray(12);
}

// --- §7 payload and §8 message ----------------------------------------

export type PayloadFields = {
  tier: number;
  proofType: number;
  measurementId: number;
  policyHash: Uint8Array;
  consentHash: Uint8Array;
  issuedAt: bigint;
  windowFrom: number;
  windowTo: number;
};

/** FORMATS §7: 83 bytes, little-endian. */
export function buildPayload(fields: Partial<PayloadFields> & { issuedAt: bigint }): Uint8Array {
  const f: PayloadFields = {
    tier: 1,
    proofType: 1,
    measurementId: 0,
    policyHash: new Uint8Array(32).fill(0x11),
    consentHash: new Uint8Array(32).fill(0x22),
    windowFrom: 1_758_844_800,
    windowTo: 1_790_380_800,
    ...fields,
  };
  const out = new Uint8Array(PAYLOAD_LEN);
  const view = new DataView(out.buffer);
  out[0] = f.tier;
  out[1] = f.proofType;
  out[2] = f.measurementId;
  out.set(f.policyHash, 3);
  out.set(f.consentHash, 35);
  view.setBigInt64(67, f.issuedAt, true);
  view.setUint32(75, f.windowFrom, true);
  view.setUint32(79, f.windowTo, true);
  return out;
}

export function payloadIssuedAt(payload: Uint8Array): bigint {
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigInt64(67, true);
}

export type MessageFields = {
  programId: Address;
  credential: Address;
  schema: Address;
  wallet: Address;
  payload: Uint8Array;
  expiry: bigint;
};

/** FORMATS §8: tag ‖ program ‖ credential ‖ schema ‖ wallet ‖ payload ‖ expiry = 232 bytes. */
export function buildMessage(f: MessageFields): Uint8Array {
  if (f.payload.length !== PAYLOAD_LEN) {
    throw new Error(`payload must be ${PAYLOAD_LEN} bytes`);
  }
  const encoder = getAddressEncoder();
  const out = new Uint8Array(MESSAGE_LEN);
  out.set(getUtf8Encoder().encode(DOMAIN_TAG), 0);
  out.set(encoder.encode(f.programId), 13);
  out.set(encoder.encode(f.credential), 45);
  out.set(encoder.encode(f.schema), 77);
  out.set(encoder.encode(f.wallet), 109);
  out.set(f.payload, 141);
  new DataView(out.buffer).setBigInt64(224, f.expiry, true);
  return out;
}

// --- secp256k1 precompile instruction ---------------------------------

/**
 * The 329-byte single-signature precompile data:
 * `1 ‖ offsets(11) ‖ eth(20) ‖ r‖s(64) ‖ v(1) ‖ message(232)`, with every
 * instruction-index field set to `index`. `mutate` edits the finished bytes
 * (after signing), so a fault leaves the signature otherwise valid.
 */
export function buildPrecompileData(
  key: EnclaveKey,
  message: Uint8Array,
  index: number,
  mutate?: (data: Uint8Array) => void,
): Uint8Array {
  const signature = signMessage(key.secretKey, message);
  const data = new Uint8Array(PRECOMPILE_DATA_LEN);
  const view = new DataView(data.buffer);
  data[0] = 1;
  view.setUint16(1, 32, true); // signature offset
  data[3] = index; // signature instruction index
  view.setUint16(4, 12, true); // eth address offset
  data[6] = index; // eth address instruction index
  view.setUint16(7, 97, true); // message offset
  view.setUint16(9, MESSAGE_LEN, true); // message size
  data[11] = index; // message instruction index
  data.set(key.ethAddress, 12);
  data.set(signature, 32);
  data.set(message, 97);
  mutate?.(data);
  return data;
}

/**
 * A two-signature precompile instruction that verifies, with both offset
 * structs pointing at the same address, signature and message. Used to prove
 * the oracle rejects `count != 1` even when the precompile accepts it.
 */
export function buildTwoSignaturePrecompileData(
  key: EnclaveKey,
  message: Uint8Array,
  index: number,
): Uint8Array {
  const signature = signMessage(key.secretKey, message);
  const base = 1 + 22;
  const ethOffset = base;
  const sigOffset = base + 20;
  const msgOffset = sigOffset + 65;
  const data = new Uint8Array(msgOffset + MESSAGE_LEN);
  const view = new DataView(data.buffer);
  data[0] = 2;
  for (const start of [1, 12]) {
    view.setUint16(start, sigOffset, true);
    data[start + 2] = index;
    view.setUint16(start + 3, ethOffset, true);
    data[start + 5] = index;
    view.setUint16(start + 6, msgOffset, true);
    view.setUint16(start + 8, MESSAGE_LEN, true);
    data[start + 10] = index;
  }
  data.set(key.ethAddress, ethOffset);
  data.set(signature, sigOffset);
  data.set(message, msgOffset);
  return data;
}

/**
 * Same as `buildPrecompileData` but with `pad` extra bytes between the offsets
 * and the address, and every offset shifted by `pad`: the precompile accepts
 * it, the oracle's fixed layout must not.
 */
export function buildShiftedPrecompileData(
  key: EnclaveKey,
  message: Uint8Array,
  index: number,
  pad: number,
): Uint8Array {
  const signature = signMessage(key.secretKey, message);
  const data = new Uint8Array(PRECOMPILE_DATA_LEN + pad);
  const view = new DataView(data.buffer);
  data[0] = 1;
  view.setUint16(1, 32 + pad, true);
  data[3] = index;
  view.setUint16(4, 12 + pad, true);
  data[6] = index;
  view.setUint16(7, 97 + pad, true);
  view.setUint16(9, MESSAGE_LEN, true);
  data[11] = index;
  data.set(key.ethAddress, 12 + pad);
  data.set(signature, 32 + pad);
  data.set(message, 97 + pad);
  return data;
}

export function precompileInstruction(data: Uint8Array): Instruction {
  return { programAddress: SECP256K1_PROGRAM, accounts: [], data };
}

// --- SAS addresses and account readers --------------------------------

export async function attestationAddress(
  credential: Address,
  schema: Address,
  wallet: Address,
): Promise<Address> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: SAS_PROGRAM_ID,
    seeds: [
      getUtf8Encoder().encode('attestation'),
      encoder.encode(credential),
      encoder.encode(schema),
      encoder.encode(wallet),
    ],
  });
  return pda;
}

export async function sasEventAuthority(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: SAS_PROGRAM_ID,
    seeds: [getUtf8Encoder().encode('__event_authority')],
  });
  return pda;
}

export type RawAccount = { owner: Address; lamports: bigint; data: Uint8Array };

export async function fetchRaw(h: Harness, at: Address): Promise<RawAccount | undefined> {
  const { value } = await h.rpc.getAccountInfo(at, { encoding: 'base64' }).send();
  if (value === null) {
    return undefined;
  }
  return {
    owner: value.owner,
    lamports: value.lamports,
    data: new Uint8Array(Buffer.from(value.data[0], 'base64')),
  };
}

export type StoredAttestation = {
  owner: Address;
  length: number;
  discriminator: number;
  nonce: Address;
  credential: Address;
  schema: Address;
  data: Uint8Array;
  signer: Address;
  expiry: bigint;
};

/** Decodes a created SAS attestation account (FORMATS §7: 256 bytes). */
export async function readAttestation(
  h: Harness,
  at: Address,
): Promise<StoredAttestation | undefined> {
  const raw = await fetchRaw(h, at);
  if (raw === undefined) {
    return undefined;
  }
  const { data } = raw;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = getAddressDecoder();
  const addr = (offset: number) => decoder.decode(data.subarray(offset, offset + 32));
  if (view.getUint32(SAS_DATA_LEN_OFFSET, true) !== PAYLOAD_LEN) {
    throw new Error('stored data length is not 83');
  }
  return {
    owner: raw.owner,
    length: data.length,
    discriminator: data[0] ?? -1,
    nonce: addr(SAS_NONCE_OFFSET),
    credential: addr(SAS_CREDENTIAL_OFFSET),
    schema: addr(SAS_SCHEMA_OFFSET),
    data: data.slice(SAS_DATA_OFFSET, SAS_DATA_OFFSET + PAYLOAD_LEN),
    signer: addr(SAS_SIGNER_OFFSET),
    expiry: view.getBigInt64(SAS_EXPIRY_OFFSET, true),
  };
}

/** A SAS-shaped 256-byte account body with the given discriminator. */
export function sasShapedAccount(discriminator: number, length = SAS_ATTESTATION_LEN): Uint8Array {
  const data = new Uint8Array(length);
  data[0] = discriminator;
  if (length > SAS_DATA_LEN_OFFSET + 3) {
    new DataView(data.buffer).setUint32(SAS_DATA_LEN_OFFSET, PAYLOAD_LEN, true);
  }
  return data;
}

/** Writes an arbitrary account (planted state), by default with a generous balance. */
export function plantAccount(
  h: Harness,
  at: Address,
  owner: Address,
  data: Uint8Array,
  lamports = 10_000_000,
): void {
  h.surfnet.setAccount(at, lamports, data, owner);
}

// --- clock ------------------------------------------------------------

/** Unix seconds of the Clock sysvar. */
export async function readClock(h: Harness): Promise<bigint> {
  const { value } = await h.rpc.getAccountInfo(CLOCK_SYSVAR, { encoding: 'base64' }).send();
  if (value === null) {
    throw new Error('clock sysvar missing');
  }
  const bytes = Buffer.from(value.data[0], 'base64');
  return bytes.readBigInt64LE(32); // slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp
}

/**
 * Moves the surfnet clock to `unixSeconds`. surfpool's `absoluteTimestamp` is
 * in MILLISECONDS and only moves forward; the clock stands still between
 * transactions, so the program sees exactly this value.
 */
export async function timeTravel(h: Harness, unixSeconds: bigint): Promise<void> {
  const current = await readClock(h);
  if (unixSeconds < current) {
    throw new Error(`cannot travel back: clock is ${current}, asked for ${unixSeconds}`);
  }
  if (unixSeconds === current) {
    return;
  }
  h.surfnet.timeTravelToTimestamp(Number(unixSeconds) * 1000);
  const after = await readClock(h);
  if (after !== unixSeconds) {
    throw new Error(`time travel landed on ${after}, expected ${unixSeconds}`);
  }
}

/** Jumps 10_000 s past the current clock (a fresh era for one test) and returns the new time. */
export async function freshClock(h: Harness): Promise<bigint> {
  const next = (await readClock(h)) + 10_000n;
  await timeTravel(h, next);
  return next;
}

// --- the submit_attestation instruction pair --------------------------

export type SubmitParams = {
  relayer: KeyPairSigner;
  /** Key that signs the message. */
  key: EnclaveKey;
  /** `enclave_entry` account (measurement id of the PDA). */
  entryId: number;
  wallet: Address;
  credential: Address;
  schema: Address;
  payload: Uint8Array;
  /** Defaults to `issued_at + 600`. */
  expiry?: bigint;
  /** Position of the precompile in the transaction (after the harness's compute-budget ix: 1). */
  precompileIndex?: number;
  /** Values written into the signed message instead of the real ones. */
  message?: Partial<Pick<MessageFields, 'programId' | 'credential' | 'schema' | 'wallet'>>;
  /** Accounts passed to the oracle instead of the derived ones. */
  accounts?: Partial<{
    credential: Address;
    schema: Address;
    attestation: Address;
    sasSigner: Address;
    instructions: Address;
    sasEventAuthority: Address;
    sasProgram: Address;
  }>;
  /** Edit the §8 message before it is signed. */
  mutateMessage?: (message: Uint8Array) => void;
  /** Edit the precompile data after it is signed. */
  mutateData?: (data: Uint8Array) => void;
  /** Build the precompile data yourself (other lengths or layouts); wins over `mutateData`. */
  buildData?: (key: EnclaveKey, message: Uint8Array, index: number) => Uint8Array;
};

export type Submission = {
  message: Uint8Array;
  precompile: Instruction;
  oracle: Instruction;
};

/** Builds the signed message, the precompile instruction and the oracle instruction. */
export async function buildSubmission(h: Harness, p: SubmitParams): Promise<Submission> {
  const message = buildMessage({
    programId: p.message?.programId ?? ORACLE_PROGRAM_ADDRESS,
    credential: p.message?.credential ?? p.credential,
    schema: p.message?.schema ?? p.schema,
    wallet: p.message?.wallet ?? p.wallet,
    payload: p.payload,
    expiry: p.expiry ?? payloadIssuedAt(p.payload) + MAX_SIGNATURE_LIFETIME_SECS,
  });
  p.mutateMessage?.(message);
  const index = p.precompileIndex ?? 1;
  const data =
    p.buildData?.(p.key, message, index) ??
    buildPrecompileData(p.key, message, index, p.mutateData);
  const [enclaveEntry] = await findEnclaveEntryPda({ measurementId: p.entryId });
  const credential = p.accounts?.credential ?? p.credential;
  const schema = p.accounts?.schema ?? p.schema;
  const attestation =
    p.accounts?.attestation ?? (await attestationAddress(credential, schema, p.wallet));
  const overrides = {
    ...(p.accounts?.sasSigner === undefined ? {} : { sasSigner: p.accounts.sasSigner }),
    ...(p.accounts?.instructions === undefined ? {} : { instructions: p.accounts.instructions }),
    ...(p.accounts?.sasEventAuthority === undefined
      ? {}
      : { sasEventAuthority: p.accounts.sasEventAuthority }),
    ...(p.accounts?.sasProgram === undefined ? {} : { sasProgram: p.accounts.sasProgram }),
  };
  const oracle = await getSubmitAttestationInstructionAsync({
    payer: p.relayer,
    credential,
    schema,
    attestation,
    enclaveEntry,
    ...overrides,
  });
  return { message, precompile: precompileInstruction(data), oracle };
}
