import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { POOL_DEFAULTS, type PoolState, planPoolSetup } from './pool-setup.ts';

const MINT = '11111111111111111111111111111112' as Address;
const CREDENTIAL = 'F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7' as Address;
const SCHEMA = '991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV' as Address;
const OTHER = 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8' as Address;

function expected(): PoolState {
  return {
    mint: MINT,
    credential: CREDENTIAL,
    schema: SCHEMA,
    params: {
      policyHash: new Uint8Array(32).fill(0x81),
      tierLimits: [...POOL_DEFAULTS.tierLimits],
      maxAgeSecs: POOL_DEFAULTS.maxAgeSecs,
      maxWindowAgeSecs: POOL_DEFAULTS.maxWindowAgeSecs,
      minWindowSecs: POOL_DEFAULTS.minWindowSecs,
      approvedMeasurements: new Uint8Array(32).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
    },
  };
}

describe('POOL_DEFAULTS', () => {
  it('holds_the_approved_demo_values', () => {
    expect(POOL_DEFAULTS).toMatchObject({
      poolId: 0,
      decimals: 6,
      maxAgeSecs: 30 * 86_400,
      maxWindowAgeSecs: 45 * 86_400,
      minWindowSecs: 180 * 86_400,
      vaultFunding: 1_000_000n * 10n ** 6n,
    });
    expect([...POOL_DEFAULTS.tierLimits]).toEqual([
      5_000n * 10n ** 6n,
      2_000n * 10n ** 6n,
      500n * 10n ** 6n,
    ]);
  });
});

describe('planPoolSetup', () => {
  it('creates_when_there_is_no_pool', () => {
    expect(planPoolSetup({ pool: null }, expected())).toEqual({ ok: true, create: true });
  });

  it('is_a_no_op_for_an_equal_pool', () => {
    expect(planPoolSetup({ pool: expected() }, expected())).toEqual({ ok: true, create: false });
  });

  const mutations: [string, (s: PoolState) => PoolState][] = [
    ['mint', (s) => ({ ...s, mint: OTHER })],
    ['credential', (s) => ({ ...s, credential: OTHER })],
    ['schema', (s) => ({ ...s, schema: OTHER })],
    [
      'policy_hash',
      (s) => ({ ...s, params: { ...s.params, policyHash: new Uint8Array(32).fill(1) } }),
    ],
    [
      'tier_a_limit',
      (s) => ({ ...s, params: { ...s.params, tierLimits: [1n, ...s.params.tierLimits.slice(1)] } }),
    ],
    [
      'tier_c_limit',
      (s) => ({
        ...s,
        params: { ...s.params, tierLimits: [...s.params.tierLimits.slice(0, 2), 1n] },
      }),
    ],
    [
      'tier_limits_shorter',
      (s) => ({ ...s, params: { ...s.params, tierLimits: s.params.tierLimits.slice(0, 2) } }),
    ],
    ['max_age', (s) => ({ ...s, params: { ...s.params, maxAgeSecs: 1 } })],
    ['max_window_age', (s) => ({ ...s, params: { ...s.params, maxWindowAgeSecs: 1 } })],
    ['min_window', (s) => ({ ...s, params: { ...s.params, minWindowSecs: 1 } })],
  ];

  // `enclave:rotate` owns the approved bitmap, so a re-run after a rotation is still a no-op.
  it('ignores_approved_measurements', () => {
    const rotated = expected();
    rotated.params = { ...rotated.params, approvedMeasurements: new Uint8Array(32).fill(2) };
    expect(planPoolSetup({ pool: rotated }, expected())).toEqual({ ok: true, create: false });
  });

  it.each(mutations)('reports_pool_mismatch_when_%s_differs', (_name, mutate) => {
    const result = planPoolSetup({ pool: mutate(expected()) }, expected());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('pool_mismatch');
    expect(result.message.length).toBeGreaterThan(0);
  });
});
