// `entryFromAccount` without a network. The generated decoder checks neither the discriminator
// nor the length, so the reader must (these tests replace the deleted `decodeEnclaveEntry` ones).
import { address } from '@solana/kit';
import { getEnclaveEntryEncoder } from '@tio/oracle-client';
import { ORACLE_PROGRAM_ID } from '@tio/oracle-client/attest';
import { describe, expect, it } from 'vitest';

import { entryFromAccount } from './registry.ts';

const ENTRY = {
  version: 1,
  bump: 253,
  measurementId: 9,
  measurementKind: 1,
  measurement: new Uint8Array(32).fill(0xaa),
  attester: new Uint8Array(20).fill(0xbb),
  attestationDocHash: new Uint8Array(32).fill(0xcc),
  registeredAt: 1_790_000_000n,
  revokedAt: 0n,
};

function entryBytes(overrides: Partial<typeof ENTRY> = {}): Uint8Array {
  return new Uint8Array(getEnclaveEntryEncoder().encode({ ...ENTRY, ...overrides }));
}

const owned = (data: Uint8Array) => ({ owner: ORACLE_PROGRAM_ID, data });

describe('entryFromAccount', () => {
  it('reads_an_active_entry', () => {
    const entry = entryFromAccount(owned(entryBytes()));
    expect(entry?.revokedAt).toBe(0n);
    expect(entry?.measurementId).toBe(9);
    expect(entry?.attester).toEqual(ENTRY.attester);
  });

  it('reads_a_revoked_entry', () => {
    const entry = entryFromAccount(owned(entryBytes({ revokedAt: 1_790_000_500n })));
    expect(entry?.revokedAt).toBe(1_790_000_500n);
  });

  it('returns_undefined_for_a_missing_account', () => {
    expect(entryFromAccount(null)).toBeUndefined();
  });

  it('returns_undefined_for_an_account_owned_by_another_program', () => {
    const other = address('11111111111111111111111111111111');
    expect(entryFromAccount({ owner: other, data: entryBytes() })).toBeUndefined();
  });

  it('throws_on_a_wrong_discriminator', () => {
    const bytes = entryBytes();
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(() => entryFromAccount(owned(bytes))).toThrow();
  });

  it('throws_on_data_one_byte_short', () => {
    const bytes = entryBytes();
    expect(() => entryFromAccount(owned(bytes.subarray(0, bytes.length - 1)))).toThrow();
  });

  it('throws_on_data_one_byte_long', () => {
    const bytes = entryBytes();
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(() => entryFromAccount(owned(longer))).toThrow();
  });

  it('throws_on_empty_data', () => {
    expect(() => entryFromAccount(owned(new Uint8Array(0)))).toThrow();
  });
});
