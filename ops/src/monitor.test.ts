import { describe, expect, it } from 'vitest';
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH } from './cluster.ts';
import {
  type Check,
  type OysterJob,
  type Probes,
  THRESHOLDS,
  decodeJob,
  evaluate,
  overall,
  paidUntil,
  renderReport,
} from './monitor.ts';

const OWNER = '0xd68918e095d1bab2aa83d5bef021f0c064c66837';
const ATTESTER = '0x7588de07d659a583c8c82261ff3b95c0e039a7f3';
const NOW = 1_792_900_000n;
const DAY = 86_400n;

// Head words of the real jobs(bytes32) answer for job 0x…320a on 2026-10-24
// (Arbitrum One market 0x9d95…a34B); the metadata string after them is irrelevant.
const JOB_320A_HEAD = [
  '00000000000000000000000000000000000000000000000000000000000000c0',
  '000000000000000000000000d68918e095d1bab2aa83d5bef021f0c064c66837',
  '000000000000000000000000e10fa12f580e660ecd593ea4119cebc90509d642',
  '000000000000000000000000000000000000000000000000000015786e77eb85',
  '0000000000000000000000000000000000000000000000000000000003b4a0a9',
  '000000000000000000000000000000000000000000000000000000006ac79f00',
].join('');

/** A job whose balance lasts exactly `days` from NOW: at rate 10^12 one balance unit is one second. */
function jobLasting(days: bigint): OysterJob {
  return { owner: OWNER, rate: 10n ** 12n, balance: days * DAY, lastSettled: NOW };
}

function healthy(): Probes {
  return {
    solanaGenesis: { ok: true, value: DEVNET_GENESIS_HASH },
    gatewayHealth: { ok: true, value: null },
    session: { ok: true, value: null },
    gatewayInfo: { ok: true, value: { measurementId: 2, attester: ATTESTER, relayer: 'R' } },
    enclaveAttester: { ok: true, value: ATTESTER.toUpperCase().replace('0X', '0x') },
    registryEntry: { ok: true, value: { attester: ATTESTER, revoked: false } },
    relayerLamports: { ok: true, value: 5_000_000_000n },
    oysterJob: { ok: true, value: jobLasting(30n) },
    indexerLagSecs: { ok: true, value: 60 },
  };
}

const byId = (checks: Check[], id: string): Check => {
  const found = checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
};

const statusOf = (probes: Probes, id: string) => byId(evaluate(probes, NOW, OWNER), id).status;

describe('decodeJob', () => {
  it('reads_owner_rate_balance_and_last_settled_from_the_real_answer', () => {
    expect(decodeJob(`0x${JOB_320A_HEAD}00`)).toEqual({
      owner: OWNER,
      rate: 23_606_993_611_653n,
      balance: 62_169_257n,
      lastSettled: 1_791_467_264n,
    });
  });

  it('returns_null_for_a_job_the_market_does_not_have', () => {
    expect(decodeJob(`0x${'0'.repeat(64 * 6)}`)).toBeNull();
  });

  it('throws_on_a_short_answer', () => {
    expect(() => decodeJob('0x00')).toThrow(/shorter than its head/);
  });
});

describe('paidUntil', () => {
  it('matches_the_real_job_paid_until_2026_11_08_01_19_34_utc', () => {
    const job = decodeJob(JOB_320A_HEAD);
    expect(job).not.toBeNull();
    if (job !== null) expect(paidUntil(job)).toBe(1_794_100_774n);
  });
});

describe('evaluate', () => {
  it('passes_every_check_when_everything_answers', () => {
    const checks = evaluate(healthy(), NOW, OWNER);
    expect(checks.map((c) => c.status)).toEqual(Array(9).fill('ok'));
    expect(overall(checks)).toBe('ok');
  });

  it.each([
    ['solanaGenesis', 'solana_cluster'],
    ['gatewayHealth', 'gateway_health'],
    ['session', 'session'],
    ['enclaveAttester', 'enclave_info'],
  ] as const)('fails_%s_as_its_own_check_%s', (key, id) => {
    const check = byId(
      evaluate({ ...healthy(), [key]: { ok: false, error: 'HTTP 502' } }, NOW, OWNER),
      id,
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('HTTP 502');
  });

  it('fails_the_cluster_check_on_another_genesis_hash', () => {
    const probes = {
      ...healthy(),
      solanaGenesis: { ok: true as const, value: MAINNET_GENESIS_HASH },
    };
    const check = byId(evaluate(probes, NOW, OWNER), 'solana_cluster');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/is not a devnet cluster/);
  });

  it('fails_attester_match_after_an_enclave_restart', () => {
    const probes = {
      ...healthy(),
      enclaveAttester: { ok: true as const, value: '0x' + '1'.repeat(40) },
    };
    const check = byId(evaluate(probes, NOW, OWNER), 'attester_match');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/recreate the gateway/);
  });

  it.each([
    ['missing', { ok: true as const, value: null }, /no entry at measurement_id 2/],
    ['revoked', { ok: true as const, value: { attester: ATTESTER, revoked: true } }, /revoked/],
    [
      'another attester',
      { ok: true as const, value: { attester: OWNER, revoked: false } },
      /names/,
    ],
  ])('fails_registry_entry_when_%s', (_why, registryEntry, detail) => {
    const check = byId(evaluate({ ...healthy(), registryEntry }, NOW, OWNER), 'registry_entry');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(detail);
  });

  it.each([
    [30n, 'ok'],
    [7n, 'ok'],
    [6n, 'warn'],
    [1n, 'warn'],
    [0n, 'fail'],
  ] as const)('oyster_runway_of_%i_days_is_%s', (days, status) => {
    expect(
      statusOf({ ...healthy(), oysterJob: { ok: true, value: jobLasting(days) } }, 'oyster_runway'),
    ).toBe(status);
  });

  it('fails_oyster_runway_for_a_rate_0_job_without_throwing', () => {
    const closing = { ...jobLasting(30n), rate: 0n };
    const checks = evaluate({ ...healthy(), oysterJob: { ok: true, value: closing } }, NOW, OWNER);
    const runway = byId(checks, 'oyster_runway');
    expect(runway.status).toBe('fail');
    expect(runway.detail).toMatch(/rate is 0/);
    expect(() => renderReport(checks, NOW)).not.toThrow();
  });

  it('reports_a_huge_balance_as_years_without_formatting_a_date', () => {
    const rich = { ...jobLasting(1n), balance: 10n ** 30n };
    const checks = evaluate({ ...healthy(), oysterJob: { ok: true, value: rich } }, NOW, OWNER);
    expect(byId(checks, 'oyster_runway')).toMatchObject({
      status: 'ok',
      detail: 'paid for over 10 years',
    });
    expect(() => renderReport(checks, NOW)).not.toThrow();
  });

  it('fails_oyster_runway_for_a_missing_job_or_another_owner', () => {
    expect(statusOf({ ...healthy(), oysterJob: { ok: true, value: null } }, 'oyster_runway')).toBe(
      'fail',
    );
    const stranger = { ...jobLasting(30n), owner: '0x' + '2'.repeat(40) };
    expect(
      statusOf({ ...healthy(), oysterJob: { ok: true, value: stranger } }, 'oyster_runway'),
    ).toBe('fail');
  });

  it.each([
    [THRESHOLDS.relayerWarnLamports, 'ok'],
    [THRESHOLDS.relayerWarnLamports - 1n, 'warn'],
    [THRESHOLDS.relayerFailLamports - 1n, 'fail'],
  ] as const)('relayer_balance_of_%i_lamports_is_%s', (lamports, status) => {
    expect(
      statusOf({ ...healthy(), relayerLamports: { ok: true, value: lamports } }, 'relayer_balance'),
    ).toBe(status);
  });

  it('only_warns_when_marlins_indexer_lags_or_is_unreachable', () => {
    const lagging = {
      ...healthy(),
      indexerLagSecs: { ok: true as const, value: THRESHOLDS.indexerWarnSecs + 1 },
    };
    expect(statusOf(lagging, 'marlin_indexer')).toBe('warn');
    expect(overall(evaluate(lagging, NOW, OWNER))).toBe('warn');
    const down = { ...healthy(), indexerLagSecs: { ok: false as const, error: 'HTTP 503' } };
    expect(statusOf(down, 'marlin_indexer')).toBe('warn');
  });

  it('fails_the_gateway_dependent_checks_when_gateway_info_is_missing', () => {
    const checks = evaluate(
      { ...healthy(), gatewayInfo: { ok: false, error: 'HTTP 502' } },
      NOW,
      OWNER,
    );
    expect(byId(checks, 'attester_match').status).toBe('fail');
    expect(byId(checks, 'registry_entry').status).toBe('fail');
  });
});

describe('renderReport', () => {
  it('lists_every_check_with_its_status_and_escapes_pipes', () => {
    const checks = evaluate(
      { ...healthy(), session: { ok: false, error: 'upstream | enclave' } },
      NOW,
      OWNER,
    );
    const md = renderReport(checks, NOW);
    expect(md).toMatch(/^\*\*Devnet demo: FAIL\*\* at 2026-/);
    expect(md).toContain(
      '| FAIL | A session starts (gateway → enclave → bank) | upstream \\| enclave |',
    );
    expect(md.split('\n').filter((l) => l.startsWith('| OK |'))).toHaveLength(8);
  });

  it('keeps_a_multi_line_or_long_detail_on_one_short_row', () => {
    const error = `unexpected\n  {\n    "code": "invalid"\n  }\n${'x'.repeat(500)}`;
    const md = renderReport(
      evaluate({ ...healthy(), session: { ok: false, error } }, NOW, OWNER),
      NOW,
    );
    const row = md.split('\n').find((l) => l.includes('A session starts'));
    expect(row).toBeDefined();
    expect(row).toMatch(/\| unexpected \{ "code": "invalid" \} x+… \|$/);
    expect((row ?? '').length).toBeLessThan(400);
    expect(md.split('\n').filter((l) => l.startsWith('|'))).toHaveLength(11);
  });
});
