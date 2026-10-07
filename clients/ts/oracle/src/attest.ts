/**
 * Hand-written attestation helpers for the oracle (FORMATS §7, §8, §13): the
 * signed §8 message, the secp256k1 precompile instruction, the SAS attestation
 * address and reader. Codama can't generate these: the precompile is a native
 * program and the attestation account belongs to SAS, not to the oracle IDL.
 *
 * Imports `@solana/kit` only (never `./generated`), so it loads under plain
 * Node type stripping — the gateway runs that way.
 */
import {
  type AccountMeta,
  AccountRole,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from '@solana/kit';

export const ORACLE_PROGRAM_ID = address('HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8');
export const SAS_PROGRAM_ID = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
export const SECP256K1_PROGRAM = address('KeccakSecp256k11111111111111111111111111111');
const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

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

// --- kit-7 workaround ------------------------------------------------------
// The Codama kit-7 client can't load under plain Node (extensionless imports,
// `enum`), so the gateway uses these three instead. Each is cross-checked
// against the generated code in attest.test.ts. Delete them and that test at
// the kit-8 move (BACKLOG "Kit 7 pin → kit 8 later").

const ENCLAVE_ENTRY_DISCRIMINATOR = new Uint8Array([110, 87, 213, 112, 185, 91, 210, 91]);
const ENCLAVE_ENTRY_LEN = 112;
const SUBMIT_ATTESTATION_DISCRIMINATOR = new Uint8Array([238, 220, 255, 105, 183, 211, 40, 83]);

async function oraclePda(seeds: (string | Uint8Array)[]): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: ORACLE_PROGRAM_ID, seeds });
  return pda;
}

/** Oracle registry PDA `["enclave", measurement_id: u8]`. */
export function enclaveEntryAddress(measurementId: number): Promise<Address> {
  return oraclePda(['enclave', Uint8Array.of(measurementId)]);
}

export type EnclaveEntry = {
  version: number;
  bump: number;
  measurementId: number;
  measurementKind: number;
  measurement: Uint8Array;
  attester: Uint8Array;
  attestationDocHash: Uint8Array;
  registeredAt: bigint;
  /** 0 while active. */
  revokedAt: bigint;
};

/** Decodes an oracle `EnclaveEntry` account (112 bytes, Anchor discriminator first). */
export function decodeEnclaveEntry(data: Uint8Array): EnclaveEntry {
  requireLength('enclave entry', data, ENCLAVE_ENTRY_LEN);
  if (!ENCLAVE_ENTRY_DISCRIMINATOR.every((b, i) => data[i] === b)) {
    throw new Error('account is not an oracle EnclaveEntry');
  }
  const v = view(data);
  return {
    version: v.getUint8(8),
    bump: v.getUint8(9),
    measurementId: v.getUint8(10),
    measurementKind: v.getUint8(11),
    measurement: data.slice(12, 44),
    attester: data.slice(44, 64),
    attestationDocHash: data.slice(64, 96),
    registeredAt: v.getBigInt64(96, true),
    revokedAt: v.getBigInt64(104, true),
  };
}

export type SubmitAttestationAccounts = {
  payer: TransactionSigner;
  credential: Address;
  schema: Address;
  attestation: Address;
  enclaveEntry: Address;
};

/** `oracle.submit_attestation` (no args), accounts in IDL order. */
export async function submitAttestationInstruction(
  a: SubmitAttestationAccounts,
): Promise<Instruction<string, readonly (AccountMeta | AccountSignerMeta)[]>> {
  const sasSigner = await oraclePda(['sas_signer']);
  const [sasEventAuthority] = await getProgramDerivedAddress({
    programAddress: SAS_PROGRAM_ID,
    seeds: ['__event_authority'],
  });
  return {
    programAddress: ORACLE_PROGRAM_ID,
    accounts: [
      { address: a.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: a.payer },
      { address: sasSigner, role: AccountRole.READONLY },
      { address: a.credential, role: AccountRole.READONLY },
      { address: a.schema, role: AccountRole.READONLY },
      { address: a.attestation, role: AccountRole.WRITABLE },
      { address: a.enclaveEntry, role: AccountRole.READONLY },
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
      { address: sasEventAuthority, role: AccountRole.READONLY },
      { address: SAS_PROGRAM_ID, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: SUBMIT_ATTESTATION_DISCRIMINATOR,
  };
}
