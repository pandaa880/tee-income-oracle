/**
 * Hand-built FORMATS §13 account bytes and PDAs, written from the spec (not from the
 * decoder under test): Anchor discriminator = sha256("account:<Name>")[0..8], Borsh
 * little-endian fields in table order.
 */

import { createHash } from 'node:crypto';

import { address as toAddress, getProgramDerivedAddress } from '@solana/kit';

export const ENTRY_SIZE = 112;
export const ATTESTER_OFFSET = 44;
export const REVOKED_AT_OFFSET = 104;

export function discriminator(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`account:${name}`).digest().subarray(0, 8));
}

export interface ConfigFields {
  readonly nextMeasurementId: number;
  /** Some = Borsh tag 1 + 32 bytes; None = tag 0 only (so later fields shift). */
  readonly pendingAdmin?: Uint8Array;
}

export function configBytes(f: ConfigFields): Uint8Array {
  const admin = new Uint8Array(32).fill(7);
  const pending = f.pendingAdmin === undefined ? [0] : [1, ...f.pendingAdmin];
  return Uint8Array.from([
    ...discriminator('Config'),
    1, // version
    254, // bump
    ...admin,
    ...pending,
    f.nextMeasurementId,
  ]);
}

export interface EntryFields {
  readonly measurementId: number;
  readonly attester: Uint8Array;
  readonly revokedAt?: bigint;
}

export function entryBytes(f: EntryFields): Uint8Array {
  const out = new Uint8Array(ENTRY_SIZE);
  out.set(discriminator('EnclaveEntry'), 0);
  out[8] = 1; // version
  out[9] = 253; // bump
  out[10] = f.measurementId;
  out[11] = 1; // measurement_kind: Oyster image id
  out.fill(0x11, 12, 44); // measurement
  out.set(f.attester, ATTESTER_OFFSET);
  out.fill(0x22, 64, 96); // attestation_doc_hash
  const view = new DataView(out.buffer);
  view.setBigInt64(96, 1_790_000_000n, true); // registered_at
  view.setBigInt64(REVOKED_AT_OFFSET, f.revokedAt ?? 0n, true);
  return out;
}

export async function configAddress(programId: string): Promise<string> {
  const [address] = await getProgramDerivedAddress({
    programAddress: toAddress(programId),
    seeds: [new TextEncoder().encode('config')],
  });
  return address;
}

export async function entryAddress(programId: string, measurementId: number): Promise<string> {
  const [address] = await getProgramDerivedAddress({
    programAddress: toAddress(programId),
    seeds: [new TextEncoder().encode('enclave'), Uint8Array.of(measurementId)],
  });
  return address;
}
