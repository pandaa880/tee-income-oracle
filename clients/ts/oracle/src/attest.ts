/**
 * Hand-written attestation helpers for the oracle (FORMATS §7, §8, §13): the
 * signed §8 message, the secp256k1 precompile instruction, the SAS attestation
 * address and reader. Codama can't generate these: the precompile is a native
 * program and the attestation account belongs to SAS, not to the oracle IDL.
 *
 * Everything the IDL describes (instructions, PDAs, the registry account) comes
 * from the Codama client in `./generated`.
 */
import {
  type Address,
  type Instruction,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from '@solana/kit';

export const ORACLE_PROGRAM_ID = address('HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8');
export const SAS_PROGRAM_ID = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
export const SECP256K1_PROGRAM = address('KeccakSecp256k11111111111111111111111111111');

export const DOMAIN_TAG = 'TIO-ATTEST-v1';
export const PAYLOAD_LEN = 83;
export const MESSAGE_LEN = 232;
export const PRECOMPILE_DATA_LEN = 329;
export const MAX_SIGNATURE_LIFETIME_SECS = 600n;
const ETH_ADDRESS_LEN = 20;
const SIGNATURE_LEN = 65;

// SAS attestation account (256 bytes, FORMATS §7).
export const SAS_ATTESTATION_LEN = 256;
export const SAS_ATTESTATION_DISCRIMINATOR = 2;
export const SAS_NONCE_OFFSET = 1;
export const SAS_CREDENTIAL_OFFSET = 33;
export const SAS_SCHEMA_OFFSET = 65;
export const SAS_DATA_LEN_OFFSET = 97;
export const SAS_DATA_OFFSET = 101;
export const SAS_SIGNER_OFFSET = 184;
export const SAS_EXPIRY_OFFSET = 216;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requireLength(name: string, bytes: Uint8Array, length: number): void {
  if (bytes.length !== length) {
    throw new Error(`${name} must be ${length} bytes, got ${bytes.length}`);
  }
}

// --- §8 message --------------------------------------------------------

export type MessageFields = {
  programId: Address;
  credential: Address;
  schema: Address;
  wallet: Address;
  payload: Uint8Array;
  expiry: bigint;
};

/** FORMATS §8: tag ‖ program ‖ credential ‖ schema ‖ wallet ‖ payload ‖ expiry (i64 LE) = 232 bytes. */
export function buildMessage(f: MessageFields): Uint8Array {
  requireLength('payload', f.payload, PAYLOAD_LEN);
  const encoder = getAddressEncoder();
  const out = new Uint8Array(MESSAGE_LEN);
  out.set(getUtf8Encoder().encode(DOMAIN_TAG), 0);
  out.set(encoder.encode(f.programId), 13);
  out.set(encoder.encode(f.credential), 45);
  out.set(encoder.encode(f.schema), 77);
  out.set(encoder.encode(f.wallet), 109);
  out.set(f.payload, 141);
  view(out).setBigInt64(224, f.expiry, true);
  return out;
}

/** The payload's `issued_at` (i64 LE at offset 67, FORMATS §7). */
export function payloadIssuedAt(payload: Uint8Array): bigint {
  return view(payload).getBigInt64(67, true);
}

/** Every field of the 83-byte FORMATS §7 payload. Hashes are copies, not views. */
export type DecodedPayload = {
  tier: number;
  proofType: number;
  measurementId: number;
  policyHash: Uint8Array;
  consentHash: Uint8Array;
  issuedAt: bigint;
  windowFrom: number;
  windowTo: number;
};

/** Decodes a FORMATS §7 payload; any length other than 83 is a `RangeError`. */
export function decodePayload(payload: Uint8Array): DecodedPayload {
  if (payload.length !== PAYLOAD_LEN) {
    throw new RangeError(`payload must be ${PAYLOAD_LEN} bytes, got ${payload.length}`);
  }
  const v = view(payload);
  return {
    tier: v.getUint8(0),
    proofType: v.getUint8(1),
    measurementId: v.getUint8(2),
    policyHash: payload.slice(3, 35),
    consentHash: payload.slice(35, 67),
    issuedAt: v.getBigInt64(67, true),
    windowFrom: v.getUint32(75, true),
    windowTo: v.getUint32(79, true),
  };
}

// --- secp256k1 precompile ------------------------------------------------

export type PrecompileParts = {
  /** 20-byte eth address of the enclave attester. */
  ethAddress: Uint8Array;
  /** 65-byte `r ‖ s ‖ v` (v ∈ {0, 1}) over keccak256(message). */
  signature: Uint8Array;
  message: Uint8Array;
  /** The precompile's own position in the transaction. */
  index: number;
};

/**
 * The 329-byte single-signature precompile data the oracle accepts (FORMATS §8):
 * `1 ‖ offsets(11) ‖ eth(20) ‖ r‖s‖v(65) ‖ message(232)`. Every
 * instruction-index field points at the precompile itself, so the bytes the
 * precompile verifies are the bytes the oracle reads.
 */
export function buildPrecompileData(p: PrecompileParts): Uint8Array {
  requireLength('eth address', p.ethAddress, ETH_ADDRESS_LEN);
  requireLength('signature', p.signature, SIGNATURE_LEN);
  requireLength('message', p.message, MESSAGE_LEN);
  const data = new Uint8Array(PRECOMPILE_DATA_LEN);
  const v = view(data);
  data[0] = 1;
  v.setUint16(1, 32, true); // signature offset
  data[3] = p.index;
  v.setUint16(4, 12, true); // eth address offset
  data[6] = p.index;
  v.setUint16(7, 97, true); // message offset
  v.setUint16(9, MESSAGE_LEN, true);
  data[11] = p.index;
  data.set(p.ethAddress, 12);
  data.set(p.signature, 32);
  data.set(p.message, 97);
  return data;
}

export function precompileInstruction(data: Uint8Array): Instruction {
  return { programAddress: SECP256K1_PROGRAM, accounts: [], data };
}

// --- SAS attestation account ---------------------------------------------

/** SAS PDA `["attestation", credential, schema, nonce = wallet]`. */
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

export type StoredAttestation = {
  nonce: Address;
  credential: Address;
  schema: Address;
  signer: Address;
  payload: Uint8Array;
  expiry: bigint;
};

/** Reads a SAS attestation account holding an 83-byte payload; throws on anything else. */
export function parseSasAttestation(owner: Address, data: Uint8Array): StoredAttestation {
  if (owner !== SAS_PROGRAM_ID) {
    throw new Error('attestation account is not owned by SAS');
  }
  requireLength('attestation account', data, SAS_ATTESTATION_LEN);
  if (data[0] !== SAS_ATTESTATION_DISCRIMINATOR) {
    throw new Error('account is not a SAS attestation');
  }
  const v = view(data);
  if (v.getUint32(SAS_DATA_LEN_OFFSET, true) !== PAYLOAD_LEN) {
    throw new Error(`attestation data length is not ${PAYLOAD_LEN}`);
  }
  const decoder = getAddressDecoder();
  const addr = (offset: number) => decoder.decode(data.subarray(offset, offset + 32));
  return {
    nonce: addr(SAS_NONCE_OFFSET),
    credential: addr(SAS_CREDENTIAL_OFFSET),
    schema: addr(SAS_SCHEMA_OFFSET),
    signer: addr(SAS_SIGNER_OFFSET),
    payload: data.slice(SAS_DATA_OFFSET, SAS_DATA_OFFSET + PAYLOAD_LEN),
    expiry: v.getBigInt64(SAS_EXPIRY_OFFSET, true),
  };
}
