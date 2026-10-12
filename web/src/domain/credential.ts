// What the pool would say about a borrower's stored tier, computed in the browser from chain
// state (CODING-GUIDELINES §3: anything shown as verified is read from RPC, not the gateway).
import type { Address } from '@solana/kit';
import type { Pool } from '@tio/demo-pool-client';
import type { Tier } from './types.ts';
import type { EnclaveEntry } from '@tio/oracle-client';
import {
  type DecodedPayload,
  type StoredAttestation,
  decodePayload,
} from '@tio/oracle-client/attest';

export type CredentialStatus =
  | 'none'
  | 'valid'
  | 'stale'
  | 'expired'
  | 'foreign_signer'
  | 'enclave_revoked'
  | 'not_approved'
  | 'policy_mismatch'
  | 'tier_not_accepted'
  | 'window_too_old'
  | 'window_too_short';

export type CredentialInput = {
  attestation?: StoredAttestation | undefined;
  enclaveEntry?: EnclaveEntry | undefined;
  pool: Pool;
  /** The oracle's SAS signer from the deployment; anything else wrote a foreign record. */
  sasSigner: Address;
  /** Unix seconds. */
  now: bigint;
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Bit `id % 8` of byte `id / 8`, as the program's `is_approved` reads it. */
function isApproved(bitmap: ArrayLike<number>, id: number): boolean {
  return ((bitmap[Math.floor(id / 8)] ?? 0) & (1 << (id % 8))) !== 0;
}

/** Every enclave build a pool's bitmap approves, ascending. */
export function approvedIds(bitmap: ArrayLike<number>): number[] {
  const ids: number[] = [];
  for (let id = 0; id < bitmap.length * 8; id++) if (isApproved(bitmap, id)) ids.push(id);
  return ids;
}

const TIER_OF: Record<number, Tier> = { 1: 'A', 2: 'B', 3: 'C' };

/** The §7 tier byte as a letter; null for anything the payload format doesn't define. */
export function tierFromByte(byte: number): Tier | null {
  return TIER_OF[byte] ?? null;
}

/** The pool's limit for a payload tier (1 = A … 3 = C); 0 means "not lent to". */
export function tierLimit(limits: readonly bigint[], tier: number): bigint {
  return tier >= 1 && tier <= 3 ? (limits[tier - 1] ?? 0n) : 0n;
}

/** `check_freshness` (programs/demo-pool/src/checks.rs): age, statement age, statement length. */
function freshness(params: Pool['params'], payload: DecodedPayload, now: bigint) {
  if (now - payload.issuedAt > BigInt(params.maxAgeSecs)) return 'stale';
  if (payload.issuedAt - BigInt(payload.windowTo) > BigInt(params.maxWindowAgeSecs)) {
    return 'window_too_old';
  }
  if (payload.windowTo - payload.windowFrom < params.minWindowSecs) return 'window_too_short';
  return null;
}

/** `check_enclave`: approved by the pool, the entry is the payload's, and not revoked. */
function enclave(params: Pool['params'], payload: DecodedPayload, entry: EnclaveEntry | undefined) {
  if (!isApproved(Uint8Array.from(params.approvedMeasurements), payload.measurementId)) {
    return 'not_approved';
  }
  if (entry === undefined || entry.measurementId !== payload.measurementId) return 'not_approved';
  if (entry.revokedAt !== 0n) return 'enclave_revoked';
  return null;
}

/**
 * Mirrors every borrow check of the pool that doesn't depend on the amount (FORMATS §14,
 * programs/demo-pool/src/instructions/borrow.rs), in the program's order, so "valid" means
 * a borrow up to the tier limit would pass.
 */
export function readCredential(input: CredentialInput): CredentialStatus {
  const { attestation, enclaveEntry, pool, sasSigner, now } = input;
  if (attestation === undefined) return 'none';
  if (attestation.signer !== sasSigner) return 'foreign_signer';
  if (now >= attestation.expiry) return 'expired';
  const payload = decodePayload(attestation.payload);
  const params = pool.params;
  if (tierLimit(params.tierLimits, payload.tier) === 0n) return 'tier_not_accepted';
  if (!sameBytes(payload.policyHash, Uint8Array.from(params.policyHash))) return 'policy_mismatch';
  return freshness(params, payload, now) ?? enclave(params, payload, enclaveEntry) ?? 'valid';
}

/** The status plus what the pages show: the decoded record and this pool's limit for its tier. */
export type CredentialRecord = {
  status: CredentialStatus;
  record: { payload: DecodedPayload; expiry: bigint } | null;
  limit: bigint;
};

export function readCredentialRecord(input: CredentialInput): CredentialRecord {
  const status = readCredential(input);
  const { attestation, pool } = input;
  if (attestation === undefined) return { status, record: null, limit: 0n };
  const payload = decodePayload(attestation.payload);
  return {
    status,
    record: { payload, expiry: attestation.expiry },
    limit: tierLimit(pool.params.tierLimits, payload.tier),
  };
}
