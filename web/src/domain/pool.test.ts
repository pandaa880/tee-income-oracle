import { describe, expect, it } from 'vitest';
import { acceptedPools, borrowCeiling, poolLabel } from './pool.ts';
import { credentialRecord } from '../test-support/credential.ts';

describe('borrowCeiling', () => {
  it.each([
    [5_000_000n, 9_000_000n, 5_000_000n],
    [5_000_000n, 2_000_000n, 2_000_000n],
    [5_000_000n, 5_000_000n, 5_000_000n],
    [5_000_000n, 0n, 0n],
    [0n, 9n, 0n],
  ])('limit %s vault %s -> %s', (limit, vault, expected) => {
    expect(borrowCeiling(limit, vault)).toBe(expected);
  });
});

describe('poolLabel', () => {
  it('shows the limit with thousands separators for a usable tier', () => {
    expect(poolLabel(0, 'valid', 5_000_000_000n, 'A')).toBe('Pool 0 · up to 5,000');
    expect(poolLabel(1, 'stale', 3_000_000_000n, 'B')).toBe('Pool 1 · up to 3,000');
  });

  it('says there is no tier when the wallet has none', () => {
    expect(poolLabel(0, 'none', 0n, null)).toBe('Pool 0 · no tier');
  });

  it('says which tier the pool does not lend to', () => {
    expect(poolLabel(1, 'tier_not_accepted', 0n, 'C')).toBe('Pool 1 · not for tier C');
  });
});

describe('acceptedPools', () => {
  it('lists pools with a valid credential and a limit', () => {
    expect(
      acceptedPools([
        { poolId: 0, record: credentialRecord('valid', { limit: 5_000_000n }) },
        { poolId: 1, record: credentialRecord('valid', { limit: 3_000_000n }) },
      ]),
    ).toEqual([
      { poolId: 0, limit: 5_000_000n },
      { poolId: 1, limit: 3_000_000n },
    ]);
  });

  it('drops a pool with limit 0 and a pool whose credential is not valid', () => {
    expect(
      acceptedPools([
        { poolId: 0, record: credentialRecord('valid', { limit: 0n }) },
        { poolId: 1, record: credentialRecord('policy_mismatch', { limit: 3_000_000n }) },
        { poolId: 2, record: credentialRecord('valid', { limit: 1_000_000n }) },
      ]),
    ).toEqual([{ poolId: 2, limit: 1_000_000n }]);
  });
});
