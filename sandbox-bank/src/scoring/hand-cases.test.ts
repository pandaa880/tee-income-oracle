import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MiniFi, MiniTxn } from './reduce.ts';
import { score, ScoreError, type Features, type Outcome, type PolicyV2 } from './score.ts';

// Replays test-fixtures/scoring/hand-cases.json: expectations worked out BY
// HAND from FORMATS §6.1 (see that file's `why` fields). The Rust scorer
// replays the same file in tio-core/tests/scoring_hand.rs.

interface HandTxn {
  readonly at: string;
  readonly credit: boolean;
  readonly amount: number;
  readonly balance: number;
  readonly bounce: boolean;
  readonly emi: boolean;
}

interface FeaturesJson {
  readonly months: number;
  readonly income_median_paise: number;
  readonly obligation_median_paise: number;
  readonly foir_bps: number;
  readonly cv_bps: number;
  readonly loans: number;
  readonly bounces: number;
  readonly unmatched_emi_bounces: number;
  readonly od_days: number;
}

type Expected =
  | { readonly error: 'window_mismatch' | 'bad_fi_data' }
  | {
      readonly tier: Outcome;
      readonly full: FeaturesJson;
      readonly recent: FeaturesJson;
    };

interface HandCase {
  readonly id: string;
  readonly why: string;
  readonly policy: 'default' | PolicyV2;
  readonly start: string;
  readonly end: string;
  readonly txns: readonly HandTxn[];
  readonly expected: Expected;
}

function readText(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');
}

const CASES = (
  JSON.parse(readText('test-fixtures/scoring/hand-cases.json')) as {
    cases: readonly HandCase[];
  }
).cases;

const DEFAULT_POLICY = JSON.parse(readText('test-vectors/policy/default.json')) as PolicyV2;

/** Days since 1970-01-01 of the written date (read as an India date). */
function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

function miniTxn(t: HandTxn): MiniTxn {
  return {
    credit: t.credit,
    amount: BigInt(t.amount),
    balance: BigInt(t.balance),
    at: Date.parse(t.at) / 1000,
    bounce: t.bounce,
    emiWord: t.emi,
  };
}

function miniFi(c: HandCase): MiniFi {
  return { startDay: dayNumber(c.start), endDay: dayNumber(c.end), txns: c.txns.map(miniTxn) };
}

function features(f: FeaturesJson): Features {
  return {
    months: f.months,
    income_median_paise: BigInt(f.income_median_paise),
    obligation_median_paise: BigInt(f.obligation_median_paise),
    foir_bps: f.foir_bps,
    cv_bps: f.cv_bps,
    loans: f.loans,
    bounces: f.bounces,
    unmatched_emi_bounces: f.unmatched_emi_bounces,
    od_days: f.od_days,
  };
}

describe('hand-calculated scoring cases', () => {
  it('has the full set with unique ids', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  describe.each(CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const policy = c.policy === 'default' ? DEFAULT_POLICY : c.policy;

    it('scores exactly as calculated by hand', () => {
      const expected = c.expected;
      if ('error' in expected) {
        let thrown: unknown;
        try {
          score(miniFi(c), policy);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(ScoreError);
        expect((thrown as ScoreError).code).toBe(expected.error);
        return;
      }
      const got = score(miniFi(c), policy);
      expect(got.outcome).toBe(expected.tier);
      expect(got.full).toEqual(features(expected.full));
      expect(got.recent).toEqual(features(expected.recent));
    });
  });
});
