/**
 * Attestation payload and signed message (FORMATS §7, §8), plus the base58
 * the vectors use for Solana addresses. Written from the byte tables, as an
 * independent second implementation of tio-core's `attest` module.
 */

export type Tier = 'A' | 'B' | 'C';

export interface PayloadFields {
  readonly tier: Tier;
  readonly proofType: number;
  readonly measurementId: number;
  readonly policyHash: Uint8Array;
  readonly consentHash: Uint8Array;
  /** Unix seconds, i64. */
  readonly issuedAt: bigint;
  /** Unix seconds, u32. */
  readonly windowFrom: number;
  readonly windowTo: number;
}

/** Fixed per deployment: the three 32-byte ids the message commits to. */
export interface AttestIds {
  readonly oracleProgramId: Uint8Array;
  readonly sasCredential: Uint8Array;
  readonly sasSchema: Uint8Array;
}

export const PAYLOAD_LEN = 83;
export const MESSAGE_LEN = 232;
const DOMAIN_TAG = new TextEncoder().encode('TIO-ATTEST-v1');
const TIER_BYTE: Readonly<Record<Tier, number>> = { A: 1, B: 2, C: 3 };
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** The 83-byte payload (§7): tier, proof_type, measurement_id, hashes, issued_at, window. */
export function buildPayload(f: PayloadFields): Uint8Array {
  const out = new Uint8Array(PAYLOAD_LEN);
  const view = new DataView(out.buffer);
  out[0] = TIER_BYTE[f.tier];
  out[1] = byteValue(f.proofType, 'proof_type');
  out[2] = byteValue(f.measurementId, 'measurement_id');
  out.set(exactly(f.policyHash, 32, 'policy_hash'), 3);
  out.set(exactly(f.consentHash, 32, 'consent_hash'), 35);
  view.setBigInt64(67, checkedI64(f.issuedAt, 'issued_at'), true);
  view.setUint32(75, checkedU32(f.windowFrom, 'window_from'), true);
  view.setUint32(79, checkedU32(f.windowTo, 'window_to'), true);
  return out;
}

/** The 232-byte message the enclave signs (§8). */
export function buildMessage(
  ids: AttestIds,
  wallet: Uint8Array,
  payload: Uint8Array,
  expiry: bigint,
): Uint8Array {
  const out = new Uint8Array(MESSAGE_LEN);
  out.set(DOMAIN_TAG, 0);
  out.set(exactly(ids.oracleProgramId, 32, 'oracle_program_id'), 13);
  out.set(exactly(ids.sasCredential, 32, 'sas_credential'), 45);
  out.set(exactly(ids.sasSchema, 32, 'sas_schema'), 77);
  out.set(exactly(wallet, 32, 'wallet'), 109);
  out.set(exactly(payload, PAYLOAD_LEN, 'payload'), 141);
  new DataView(out.buffer).setBigInt64(224, checkedI64(expiry, 'expiry'), true);
  return out;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Bitcoin-alphabet base58; each leading zero byte becomes a leading '1'. */
export function base58Encode(bytes: Uint8Array): string {
  const zeros = bytes.findIndex((b) => b !== 0);
  const leading = zeros === -1 ? bytes.length : zeros;
  let n = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  let digits = '';
  while (n > 0n) {
    digits = ALPHABET.charAt(Number(n % 58n)) + digits;
    n /= 58n;
  }
  return '1'.repeat(leading) + digits;
}

/** Inverse of {@link base58Encode}; throws on a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  const leading = text.length - text.replace(/^1+/, '').length;
  let n = 0n;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit === -1) {
      throw new Error(`invalid base58 character ${JSON.stringify(ch)}`);
    }
    n = n * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...Array.from({ length: leading }, () => 0), ...body]);
}

function exactly(bytes: Uint8Array, length: number, name: string): Uint8Array {
  if (bytes.length !== length) {
    throw new Error(`${name} must be ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function byteValue(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${name} must fit a byte, got ${value}`);
  }
  return value;
}

function checkedU32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${name} must fit u32, got ${value}`);
  }
  return value;
}

function checkedI64(value: bigint, name: string): bigint {
  if (value < I64_MIN || value > I64_MAX) {
    throw new Error(`${name} must fit i64, got ${value}`);
  }
  return value;
}
