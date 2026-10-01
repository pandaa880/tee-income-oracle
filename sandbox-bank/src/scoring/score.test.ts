import { describe, expect, it } from 'vitest';
import type { MiniFi, MiniTxn } from './reduce.ts';
import { score, ScoreError, type Scores, type PolicyV2 } from './score.ts';

// Every number below is worked out from FORMATS §6.1 by hand (see the Rust
// twin in tio-core/src/score/tests.rs); none is read off this scorer.

const BAL = 1_000_000_000n;
const INCOME = 100_000n;
const EMI = 10_000n;
const IST_OFFSET = 19_800;

const DEFAULT_POLICY: PolicyV2 = {
  recurrence: { amount_tol_bps: 1000, day_tol: 5, min_occurrences: 3 },
  recent_months: 3,
  tiers: [
    { tier: 'A', foir_max_bps: 4000, cv_max_bps: 1500, bounces_max: 0 },
    { tier: 'B', foir_max_bps: 5500, cv_max_bps: 5000, bounces_max: 1 },
    { tier: 'C', foir_max_bps: 7000, cv_max_bps: 6000, bounces_max: 3 },
  ],
  reject_if: { od_days_min: 30 },
};

const H1 = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
const Q1 = ['2026-01', '2026-02', '2026-03'];

// ---------------------------------------------------------------- builders

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

/** Unix seconds of `hour`:00 India time on the written date. */
function ist(date: string, hour = 12): number {
  return dayNumber(date) * 86_400 + hour * 3_600 - IST_OFFSET;
}

interface TxnFields {
  readonly credit: boolean;
  readonly amount: bigint;
  readonly balance?: bigint;
  readonly bounce?: boolean;
  readonly emiWord?: boolean;
  readonly hour?: number;
}

function txn(date: string, f: TxnFields): MiniTxn {
  return {
    credit: f.credit,
    amount: f.amount,
    balance: f.balance ?? BAL,
    at: ist(date, f.hour ?? 12),
    bounce: f.bounce ?? false,
    emiWord: f.emiWord ?? false,
  };
}

const income = (date: string, amount = INCOME): MiniTxn => txn(date, { credit: true, amount });
const emi = (date: string, amount = EMI): MiniTxn =>
  txn(date, { credit: false, amount, emiWord: true });
const emiBounce = (date: string, amount = EMI): MiniTxn =>
  txn(date, { credit: false, amount, emiWord: true, bounce: true });
const plainBounce = (date: string): MiniTxn =>
  txn(date, { credit: false, amount: 500n, bounce: true });
/** A debit with no flags: ignored by classification, moves the balance. */
const spend = (date: string, balance: bigint, hour = 12): MiniTxn =>
  txn(date, { credit: false, amount: 5n, balance, hour });

const incomes = (months: readonly string[]): MiniTxn[] => months.map((m) => income(`${m}-01`));
const emis = (months: readonly string[], dom: string, amount = EMI): MiniTxn[] =>
  months.map((m) => emi(`${m}-${dom}`, amount));

function fi(start: string, end: string, txns: readonly MiniTxn[]): MiniFi {
  return { startDay: dayNumber(start), endDay: dayNumber(end), txns };
}

function scores(start: string, end: string, txns: readonly MiniTxn[], p = DEFAULT_POLICY): Scores {
  return score(fi(start, end, txns), p);
}

const q1 = (extra: readonly MiniTxn[]): Scores =>
  scores('2026-01-01', '2026-03-31', [...incomes(Q1), ...extra]);
const h1 = (extra: readonly MiniTxn[]): Scores =>
  scores('2026-01-01', '2026-06-30', [...incomes(H1), ...extra]);

// Fixture helpers kept at module scope (oxlint consistent-function-scoping).

const incomeSeries = (values: readonly bigint[]): Scores =>
  scores(
    '2026-01-01',
    '2026-03-31',
    values.map((v, i) => income(`2026-0${i + 1}-10`, v)),
  );

const bounceDays = (n: number): MiniTxn[] =>
  Array.from({ length: n }, (_, i) => plainBounce(`2026-01-0${i + 1}`));

/** Loans found from Jan 5 / Feb 5 (10_000 each) and a third payment. */
const loansWithThirdAmount = (third: bigint): number =>
  q1([emi('2026-01-05', 10_000n), emi('2026-02-05', 10_000n), emi('2026-03-05', third)]).full.loans;

/** Loans found from Jan 5 / Feb 10 and a third payment on `third`. */
const loansWithThirdDay = (third: string): number =>
  q1([emi('2026-01-05'), emi('2026-02-10'), emi(third)]).full.loans;

/** Loans found from Jan 10 / Feb 5 and a third payment on `third`. */
const loansFromTenth = (third: string): number =>
  q1([emi('2026-01-10'), emi('2026-02-05'), emi(third)]).full.loans;

function monthCount(start: string, end: string): number {
  const txns = ['2025-12', '2026-01', '2026-02', '2026-03']
    .map((m) => `${m}-15`)
    .filter((d) => dayNumber(d) >= dayNumber(start) && dayNumber(d) <= dayNumber(end))
    .map((d) => income(d));
  return scores(start, end, txns).full.months;
}

const odDays = (extra: readonly MiniTxn[]): number => q1(extra).full.od_days;

const creditAt = (at: number): Scores =>
  score(
    fi('2026-01-01', '2026-01-31', [
      { credit: true, amount: INCOME, balance: BAL, at, bounce: false, emiWord: false },
    ]),
    DEFAULT_POLICY,
  );

const strayIgnoredTxn = (): Scores =>
  scores('2026-01-01', '2026-01-31', [income('2026-01-10'), spend('2026-02-10', BAL)]);

const hugeIncomeSum = (): Scores =>
  scores('2026-01-01', '2026-03-31', [
    income('2026-01-10', 9_223_372_036_854_775_807n),
    income('2026-01-11', 1n),
    income('2026-02-10'),
    income('2026-03-10'),
  ]);

const hugeObligationSum = (): Scores => {
  const half = 5_000_000_000_000_000_000n;
  return q1([...emis(Q1, '05', half), ...emis(Q1, '06', half)]);
};

const hugeCv = (): Scores =>
  scores('2026-01-01', '2026-03-31', [income('2026-01-10', 9_000_000_000_000_000_000n)]);

const busy = (): MiniTxn[] => [
  ...incomes(H1),
  ...emis(H1, '05'),
  plainBounce('2026-02-20'),
  spend('2026-03-10', -5n),
  txn('2026-03-10', { credit: true, amount: 5n, bounce: true }),
  spend('2026-04-12', -7n, 9),
];

function policyWith(overrides: Partial<PolicyV2>): PolicyV2 {
  return { ...DEFAULT_POLICY, ...overrides };
}

function errorCodeOf(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    if (e instanceof ScoreError) {
      return e.code;
    }
    throw e;
  }
  return 'no error';
}

// --------------------------------------------------------------------- CV

describe('cv_bps through score()', () => {
  it('[1,1,2] is 3535, not the 2500 of an early isqrt', () => {
    expect(incomeSeries([1n, 1n, 2n]).full.cv_bps).toBe(3535);
  });

  it('is scale invariant: [100,100,200] is also 3535', () => {
    expect(incomeSeries([100n, 100n, 200n]).full.cv_bps).toBe(3535);
  });

  it('is 0 for constant income', () => {
    expect(incomeSeries([100n, 100n, 100n]).full.cv_bps).toBe(0);
  });

  it('is 0 when there is no income at all', () => {
    expect(scores('2026-01-01', '2026-03-31', []).full.cv_bps).toBe(0);
  });

  it('[1,2,3,4] floors to 4472 and the recent [2,3,4] to 2721', () => {
    const s = scores(
      '2026-01-01',
      '2026-04-30',
      [1n, 2n, 3n, 4n].map((v, i) => income(`2026-0${i + 1}-10`, v)),
    );
    expect(s.full.cv_bps).toBe(4472);
    expect(s.recent.cv_bps).toBe(2721);
  });

  it('takes the floor of the mean of the two middle months for an even count', () => {
    const s = scores(
      '2026-01-01',
      '2026-04-30',
      [1n, 2n, 3n, 4n].map((v, i) => income(`2026-0${i + 1}-10`, v)),
    );
    expect(s.full.income_median_paise).toBe(2n); // (2+3)/2 = 2.5 -> 2
    expect(s.recent.income_median_paise).toBe(3n);
  });
});

// --------------------------------------------------------- tier selection

describe('tier selection', () => {
  it('gives A to a clean statement', () => {
    const s = h1([]);
    expect(s.outcome).toBe('A');
    expect(s.full.months).toBe(6);
    expect(s.recent.months).toBe(3);
  });

  it('keeps FOIR equal to the tier limit in that tier', () => {
    const s = h1(emis(H1, '05', 40_000n));
    expect(s.full.foir_bps).toBe(4000);
    expect(s.outcome).toBe('A');
  });

  it('moves FOIR one bps over the limit to the next tier', () => {
    const s = h1(emis(H1, '05', 40_010n));
    expect(s.full.foir_bps).toBe(4001);
    expect(s.outcome).toBe('B');
  });

  it('floors FOIR instead of rounding it', () => {
    const s = h1(emis(H1, '05', 40_009n));
    expect(s.full.foir_bps).toBe(4000);
    expect(s.outcome).toBe('A');
  });

  it('maps 1 bounce to B, 2 and 3 to C, and 4 to REJECT', () => {
    expect(h1(bounceDays(1)).outcome).toBe('B');
    expect(h1(bounceDays(2)).outcome).toBe('C');
    expect(h1(bounceDays(3)).outcome).toBe('C');
    expect(h1(bounceDays(4)).outcome).toBe('REJECT');
  });

  it('takes the worse of full and recent', () => {
    const s = h1([plainBounce('2026-01-10')]);
    expect(s.full.bounces).toBe(1);
    expect(s.recent.bounces).toBe(0);
    expect(s.outcome).toBe('B');
  });

  it('lets a full-window REJECT beat a clean recent window', () => {
    const s = h1([emiBounce('2026-02-10')]);
    expect(s.full.unmatched_emi_bounces).toBe(1);
    expect(s.recent.unmatched_emi_bounces).toBe(0);
    expect(s.outcome).toBe('REJECT');
  });

  it('rejects a statement with no income', () => {
    const s = scores('2026-01-01', '2026-03-31', []);
    expect(s.full.months).toBe(3);
    expect(s.full.income_median_paise).toBe(0n);
    expect(s.outcome).toBe('REJECT');
  });

  it('rejects FOIR saturated at the u32 cap even if a tier allows u32::MAX', () => {
    const p = policyWith({
      tiers: [
        { tier: 'A', foir_max_bps: 4_294_967_295, cv_max_bps: 4_294_967_295, bounces_max: 99 },
      ],
    });
    // Income 10_000 and an obligation of 4_294_967_295 paise a month give
    // exactly u32::MAX bps, which means "at or above the cap".
    const txns = [
      ...Q1.map((m) => income(`${m}-01`, 10_000n)),
      ...Q1.map((m) => emi(`${m}-05`, 4_294_967_295n)),
    ];
    const s = scores('2026-01-01', '2026-03-31', txns, p);
    expect(s.full.foir_bps).toBe(4_294_967_295);
    expect(s.outcome).toBe('REJECT');
  });

  it('keeps FOIR one below the u32 cap and awards the tier', () => {
    const p = policyWith({
      tiers: [
        { tier: 'A', foir_max_bps: 4_294_967_295, cv_max_bps: 4_294_967_295, bounces_max: 99 },
      ],
    });
    const txns = [
      ...Q1.map((m) => income(`${m}-01`, 10_000n)),
      ...Q1.map((m) => emi(`${m}-05`, 4_294_967_294n)),
    ];
    const s = scores('2026-01-01', '2026-03-31', txns, p);
    expect(s.full.foir_bps).toBe(4_294_967_294);
    expect(s.outcome).toBe('A');
  });
});

// ------------------------------------------------- classification parts

describe('classification', () => {
  it('counts a credit with an EMI word as income, not a loan', () => {
    const extra = Q1.map((m) => txn(`${m}-05`, { credit: true, amount: 5_000n, emiWord: true }));
    const s = q1(extra);
    expect(s.full.income_median_paise).toBe(INCOME + 5_000n);
    expect(s.full.loans).toBe(0);
  });

  it('ignores a credit with a bounce word: not income, not a bounce', () => {
    const extra = Q1.map((m) => txn(`${m}-05`, { credit: true, amount: 5_000n, bounce: true }));
    const s = q1(extra);
    expect(s.full.income_median_paise).toBe(INCOME);
    expect(s.full.bounces).toBe(0);
    expect(s.full.unmatched_emi_bounces).toBe(0);
  });

  it('ignores a credit with both words', () => {
    const s = q1([
      txn('2026-01-05', { credit: true, amount: 5_000n, bounce: true, emiWord: true }),
    ]);
    expect(s.full.income_median_paise).toBe(INCOME);
    expect(s.full.bounces).toBe(0);
    expect(s.full.unmatched_emi_bounces).toBe(0);
  });

  it('counts a debit with only a bounce word as a bounce without EMI evidence', () => {
    const s = q1([plainBounce('2026-02-10')]);
    expect(s.full.bounces).toBe(1);
    expect(s.full.unmatched_emi_bounces).toBe(0);
    expect(s.outcome).toBe('B');
  });

  it('treats a debit with both words as a bounce and never as a loan payment', () => {
    const s = q1(Q1.map((m) => emiBounce(`${m}-05`)));
    expect(s.full.loans).toBe(0);
    expect(s.full.bounces).toBe(3);
    expect(s.full.unmatched_emi_bounces).toBe(3);
  });

  it('treats a debit with only an EMI word as a loan candidate', () => {
    expect(q1(emis(Q1, '05')).full.loans).toBe(1);
  });

  it('ignores a debit with no words', () => {
    const extra = Q1.map((m) => txn(`${m}-05`, { credit: false, amount: EMI }));
    const s = q1(extra);
    expect(s.full.loans).toBe(0);
    expect(s.full.bounces).toBe(0);
    expect(s.full.obligation_median_paise).toBe(0n);
  });
});

// -------------------------------------------------------------- recurrence

describe('loan recurrence', () => {
  it('makes one loan from three monthly instalments', () => {
    const s = q1(emis(Q1, '05'));
    expect(s.full.loans).toBe(1);
    expect(s.full.obligation_median_paise).toBe(EMI);
    expect(s.full.foir_bps).toBe(1000);
  });

  it('does not make a loan from two months', () => {
    const s = q1(emis(Q1.slice(0, 2), '05'));
    expect(s.full.loans).toBe(0);
    expect(s.full.obligation_median_paise).toBe(0n);
  });

  it('honours min_occurrences from the policy', () => {
    const p = policyWith({ recurrence: { amount_tol_bps: 1000, day_tol: 5, min_occurrences: 2 } });
    const s = scores(
      '2026-01-01',
      '2026-03-31',
      [...incomes(Q1), ...emis(Q1.slice(0, 2), '05')],
      p,
    );
    expect(s.full.loans).toBe(1);
  });

  it('does not let a second debit in a taken month join (month rule alone)', () => {
    expect(q1([emi('2026-01-05'), emi('2026-01-06'), emi('2026-02-05')]).full.loans).toBe(0);
  });

  it('does not let a debit already in a cluster join a later one', () => {
    const s = q1([emi('2026-01-05'), emi('2026-01-06'), emi('2026-02-05'), emi('2026-03-05')]);
    expect(s.full.loans).toBe(1);
  });

  it('joins an amount exactly at the tolerance and rejects one paise over', () => {
    expect(loansWithThirdAmount(11_000n)).toBe(1);
    expect(loansWithThirdAmount(11_001n)).toBe(0);
    expect(loansWithThirdAmount(9_000n)).toBe(1);
    expect(loansWithThirdAmount(8_999n)).toBe(0);
  });

  it('joins a day exactly at the tolerance and rejects one day over', () => {
    expect(loansWithThirdDay('2026-03-10')).toBe(1);
    expect(loansWithThirdDay('2026-03-11')).toBe(0);
  });

  it('applies the day tolerance below the anchor as well', () => {
    expect(loansFromTenth('2026-03-05')).toBe(1);
    expect(loansFromTenth('2026-03-04')).toBe(0);
  });

  it('compares members with the anchor, not with the previous member', () => {
    expect(
      q1([emi('2026-01-05', 10_000n), emi('2026-02-05', 10_900n), emi('2026-03-05', 11_800n)]).full
        .loans,
    ).toBe(0);
    expect(q1([emi('2026-01-05'), emi('2026-02-09'), emi('2026-03-13')]).full.loans).toBe(0);
  });

  it('uses the median member amount as the scheduled amount', () => {
    const s = scores('2026-01-01', '2026-04-30', [
      ...incomes(['2026-01', '2026-02', '2026-03', '2026-04']),
      emi('2026-01-05', 10_000n),
      emi('2026-02-05', 10_001n),
      emi('2026-03-05', 10_002n),
      emi('2026-04-05', 10_003n),
    ]);
    expect(s.full.obligation_median_paise).toBe(10_001n);
  });

  it('turns two equal instalments every month into two loans', () => {
    const s = q1([...emis(Q1, '05'), ...emis(Q1, '06')]);
    expect(s.full.loans).toBe(2);
    expect(s.full.obligation_median_paise).toBe(2n * EMI);
  });

  it('does not turn three equal debits in one month into a loan', () => {
    const s = q1([emi('2026-01-05'), emi('2026-01-06'), emi('2026-01-07')]);
    expect(s.full.loans).toBe(0);
    expect(s.full.obligation_median_paise).toBe(0n);
  });

  it('counts a loan only from the month of its first payment', () => {
    const s = h1(emis(H1.slice(3), '05'));
    expect(s.full.loans).toBe(1);
    expect(s.full.obligation_median_paise).toBe(EMI / 2n);
    expect(s.recent.obligation_median_paise).toBe(EMI);
  });

  it('counts a loan in the month of a first payment on its last day', () => {
    const s = h1([emi('2026-04-30'), emi('2026-05-29'), emi('2026-06-28')]);
    expect(s.full.loans).toBe(1);
    expect(s.full.obligation_median_paise).toBe(EMI / 2n);
  });

  it('keeps a loan after its last payment', () => {
    const s = h1(emis(H1.slice(0, 3), '05'));
    expect(s.full.obligation_median_paise).toBe(EMI);
    expect(s.recent.obligation_median_paise).toBe(EMI);
    expect(s.recent.loans).toBe(1);
  });

  it('keeps FOIR unchanged through two bounced months', () => {
    const paid = h1(emis(H1, '05'));
    const bounced = h1([
      ...emis(['2026-01', '2026-02', '2026-03', '2026-06'], '05'),
      emiBounce('2026-04-05'),
      emiBounce('2026-05-05'),
    ]);
    expect(bounced.full.foir_bps).toBe(paid.full.foir_bps);
    expect(bounced.full.obligation_median_paise).toBe(EMI);
    expect(bounced.full.unmatched_emi_bounces).toBe(0);
    expect(bounced.full.bounces).toBe(2);
  });

  it('does not lose precision with amounts beyond 2^53', () => {
    const big = 9_000_000_000_000_000_000n;
    const s = q1([emi('2026-01-05', big), emi('2026-02-05', big), emi('2026-03-05', big + 1n)]);
    expect(s.full.loans).toBe(1);
    expect(s.full.foir_bps).toBe(4_294_967_295);
    expect(s.outcome).toBe('REJECT');
  });
});

// -------------------------------------------------- UnmeasuredDebt guard

const JAN_APR = ['2026-01', '2026-02', '2026-03', '2026-04'];

/** Loan due on the 5th, paid Jan-Mar; one EMI bounce in April on `day`. */
const aprilBounceOn = (day: string): Scores =>
  scores('2026-01-01', '2026-04-30', [
    ...incomes(JAN_APR),
    ...emis(Q1, '05'),
    emiBounce(`2026-04-${day}`),
  ]);

describe('unmatched EMI bounces', () => {
  const april = JAN_APR;

  it('does not explain a bounce far from the missed loan due day (review of #17)', () => {
    const s = aprilBounceOn('20');
    expect(s.full.unmatched_emi_bounces).toBe(1);
    expect(s.outcome).toBe('REJECT');
  });

  it('explains a bounce exactly day_tol from the due day, not one day more', () => {
    expect(aprilBounceOn('10').full.unmatched_emi_bounces).toBe(0);
    expect(aprilBounceOn('11').full.unmatched_emi_bounces).toBe(1);
  });

  it('does not explain a bounce on the due day of a loan paid that month', () => {
    expect(q1([...emis(Q1, '05'), emiBounce('2026-03-05')]).full.unmatched_emi_bounces).toBe(1);
  });

  it('never forms a loan from zero-amount EMI debits (review of #17)', () => {
    const s = scores('2026-01-01', '2026-04-30', [
      ...incomes(april),
      ...emis(Q1, '05', 0n),
      emiBounce('2026-04-05'),
    ]);
    expect(s.full.loans).toBe(0);
    expect(s.full.unmatched_emi_bounces).toBe(1);
    expect(s.outcome).toBe('REJECT');
  });

  it('explains a bounce by a known loan that missed that month', () => {
    const s = scores('2026-01-01', '2026-04-30', [
      ...incomes(april),
      ...emis(Q1, '05'),
      emiBounce('2026-04-05'),
    ]);
    expect(s.full.bounces).toBe(1);
    expect(s.full.unmatched_emi_bounces).toBe(0);
    expect(s.outcome).toBe('B');
  });

  it('does not explain a bounce in a month every known loan paid', () => {
    const s = q1([...emis(Q1, '05'), emiBounce('2026-03-15', 50_000n)]);
    expect(s.full.unmatched_emi_bounces).toBe(1);
    expect(s.outcome).toBe('REJECT');
  });

  it('leaves one unmatched when two bounces meet one missed loan', () => {
    const s = scores('2026-01-01', '2026-04-30', [
      ...incomes(april),
      ...emis(Q1, '05'),
      emiBounce('2026-04-05'),
      emiBounce('2026-04-06'),
    ]);
    expect(s.full.unmatched_emi_bounces).toBe(1);
    expect(s.outcome).toBe('REJECT');
  });

  it('is fine with no bounce and no loan', () => {
    const s = q1([]);
    expect(s.full.unmatched_emi_bounces).toBe(0);
    expect(s.outcome).toBe('A');
  });

  it('never goes negative for a missed month without a bounce', () => {
    const s = scores('2026-01-01', '2026-04-30', [...incomes(april), ...emis(Q1, '05')]);
    expect(s.full.unmatched_emi_bounces).toBe(0);
  });

  it('does not explain a bounce before the loan first payment', () => {
    const s = h1([...emis(H1.slice(2, 5), '05'), emiBounce('2026-02-10')]);
    expect(s.full.unmatched_emi_bounces).toBe(1);
    expect(s.recent.unmatched_emi_bounces).toBe(0);
    expect(s.outcome).toBe('REJECT');
  });

  it('rejects a NACH retry that succeeds in the same month as its bounce', () => {
    const s = scores('2026-01-01', '2026-04-30', [
      ...incomes(april),
      emi('2026-01-05'),
      emi('2026-02-05'),
      emiBounce('2026-03-05'),
      emi('2026-03-08'),
      emi('2026-04-05'),
    ]);
    expect(s.full.loans).toBe(1);
    expect(s.full.unmatched_emi_bounces).toBe(1);
    expect(s.outcome).toBe('REJECT');
  });
});

// --------------------------------------------------------- complete months

describe('complete months', () => {
  it('counts only fully covered calendar months', () => {
    expect(monthCount('2026-01-01', '2026-03-31')).toBe(3);
    expect(monthCount('2026-01-02', '2026-03-31')).toBe(2);
    expect(monthCount('2026-01-01', '2026-03-30')).toBe(2);
    expect(monthCount('2025-12-01', '2026-01-31')).toBe(2);
  });

  it('ends a leap February on the 29th', () => {
    expect(scores('2028-02-01', '2028-02-29', []).full.months).toBe(1);
    expect(scores('2028-02-01', '2028-02-28', []).full.months).toBe(0);
  });

  it('leaves income of an incomplete month out of the sums', () => {
    const s = scores('2026-01-02', '2026-03-31', [
      income('2026-01-15', 999n),
      income('2026-02-15'),
      income('2026-03-15'),
    ]);
    expect(s.full.months).toBe(2);
    expect(s.full.income_median_paise).toBe(INCOME);
    expect(s.full.cv_bps).toBe(0);
  });

  it('scores the last recent_months months as recent', () => {
    const txns = [income('2026-01-01', 1n), ...incomes(H1.slice(1))];
    const s = scores('2026-01-01', '2026-06-30', txns);
    expect(s.full.months).toBe(6);
    expect(s.recent.months).toBe(3);
    expect(s.recent.income_median_paise).toBe(INCOME);
    expect(s.recent.cv_bps).toBe(0);
  });

  it('makes recent equal full when there are fewer months than recent_months', () => {
    const s = scores('2026-01-01', '2026-02-28', [
      ...incomes(H1.slice(0, 2)),
      emiBounce('2026-02-10'),
    ]);
    expect(s.full.months).toBe(2);
    expect(s.recent).toEqual(s.full);
  });

  it('scores only the last month for recent_months 1', () => {
    const s = scores(
      '2026-01-01',
      '2026-06-30',
      [...incomes(H1), plainBounce('2026-02-10')],
      policyWith({ recent_months: 1 }),
    );
    expect(s.recent.months).toBe(1);
    expect(s.recent.bounces).toBe(0);
    expect(s.full.bounces).toBe(1);
  });

  it('rejects with empty features when no month is complete', () => {
    const s = scores('2026-01-05', '2026-01-20', [income('2026-01-10'), plainBounce('2026-01-12')]);
    expect(s.outcome).toBe('REJECT');
    expect(s.full.months).toBe(0);
    expect(s.full.income_median_paise).toBe(0n);
    expect(s.recent.months).toBe(0);
    expect(s.full.bounces).toBe(1);
    expect(s.recent.bounces).toBe(0);
  });

  it('counts bounces and overdraft of a partial month for full only', () => {
    const s = scores('2026-01-15', '2026-04-30', [
      plainBounce('2026-01-20'),
      spend('2026-01-20', -5n, 13),
      ...incomes(['2026-02', '2026-03', '2026-04']),
    ]);
    expect(s.full.months).toBe(3);
    expect(s.full.bounces).toBe(1);
    expect(s.recent.bounces).toBe(0);
    expect(s.full.od_days).toBe(12);
    expect(s.recent.od_days).toBe(0);
  });
});

// --------------------------------------------------------------- overdraft

describe('overdraft days', () => {
  it('carries a negative balance over days without transactions', () => {
    expect(odDays([spend('2026-01-10', -5n)])).toBe(22);
  });

  it('does not count days before the first transaction', () => {
    const s = scores('2026-01-01', '2026-03-31', [
      spend('2026-01-05', -5n),
      income('2026-02-01'),
      income('2026-03-01'),
    ]);
    expect(s.full.od_days).toBe(27);
  });

  it('runs to the statement end and no further', () => {
    expect(odDays([spend('2026-03-20', -5n)])).toBe(12);
  });

  it('judges a day by its last transaction (negative then positive)', () => {
    expect(
      odDays([
        spend('2026-01-10', -5n, 9),
        txn('2026-01-10', { credit: true, amount: 5n, bounce: true, hour: 15 }),
      ]),
    ).toBe(0);
  });

  it('judges a day by its last transaction (positive then negative)', () => {
    expect(
      odDays([
        txn('2026-01-10', { credit: true, amount: 5n, bounce: true, hour: 9 }),
        spend('2026-01-10', -5n, 15),
      ]),
    ).toBe(22);
  });

  it('does not count a balance of exactly zero', () => {
    expect(odDays([spend('2026-01-10', 0n)])).toBe(0);
  });

  it('does not reject at 29 days', () => {
    const s = q1([spend('2026-01-02', -5n), spend('2026-01-31', 10n)]);
    expect(s.full.od_days).toBe(29);
    expect(s.outcome).toBe('A');
  });

  it('rejects at 30 days', () => {
    const s = q1([spend('2026-01-02', -5n)]);
    expect(s.full.od_days).toBe(30);
    expect(s.outcome).toBe('REJECT');
  });

  it('takes od_days_min from the policy', () => {
    const s = scores(
      '2026-01-01',
      '2026-03-31',
      [...incomes(Q1), spend('2026-01-10', -5n), spend('2026-01-12', 10n)],
      policyWith({ reject_if: { od_days_min: 2 } }),
    );
    expect(s.full.od_days).toBe(2);
    expect(s.outcome).toBe('REJECT');
  });
});

// ------------------------------------------------------------------ bounds

describe('statement bounds (India days)', () => {
  it('accepts the first second of the start day', () => {
    expect(() => creditAt(ist('2026-01-01', 0))).not.toThrow();
  });

  it('rejects one second before the start day with window_mismatch', () => {
    expect(errorCodeOf(() => creditAt(ist('2026-01-01', 0) - 1))).toBe('window_mismatch');
  });

  it('accepts the last second of the end day', () => {
    expect(() => creditAt(ist('2026-02-01', 0) - 1)).not.toThrow();
  });

  it('rejects the first second after the end day with window_mismatch', () => {
    expect(errorCodeOf(() => creditAt(ist('2026-02-01', 0)))).toBe('window_mismatch');
  });

  it('reads 2026-01-01T00:30+05:30 as January 1, not December 31', () => {
    expect(() => creditAt(ist('2026-01-01', 0) + 1_800)).not.toThrow();
  });

  it('reads 2026-01-31T18:31Z as February 1, outside a statement ending January 31', () => {
    expect(errorCodeOf(() => creditAt(Date.parse('2026-01-31T18:31:00Z') / 1000))).toBe(
      'window_mismatch',
    );
  });

  it('puts 2026-01-31T18:31Z in February income', () => {
    const s = scores('2026-01-01', '2026-02-28', [
      income('2026-01-10', 10_000n),
      {
        credit: true,
        amount: 30_000n,
        balance: BAL,
        at: Date.parse('2026-01-31T18:31:00Z') / 1000,
        bounce: false,
        emiWord: false,
      },
    ]);
    expect(s.full.income_median_paise).toBe(20_000n);
    expect(s.full.cv_bps).toBe(5000);
  });

  it('rejects an ignored transaction outside the statement too', () => {
    expect(errorCodeOf(strayIgnoredTxn)).toBe('window_mismatch');
  });
});

// ---------------------------------------------------------------- overflow

describe('overflow', () => {
  it('throws bad_fi_data when a monthly income sum exceeds i64', () => {
    expect(errorCodeOf(hugeIncomeSum)).toBe('bad_fi_data');
  });

  it('throws bad_fi_data when a monthly obligation sum exceeds i64', () => {
    expect(errorCodeOf(hugeObligationSum)).toBe('bad_fi_data');
  });

  it('throws bad_fi_data when the CV arithmetic exceeds u128', () => {
    expect(errorCodeOf(hugeCv)).toBe('bad_fi_data');
  });
});

// ---------------------------------------------------------------- ordering

describe('transaction order', () => {
  it('gives the same scores for an input permutation that keeps equal-time order', () => {
    const original = busy().toSorted((a, b) => a.at - b.at); // stable
    const groups: MiniTxn[][] = [];
    for (const t of original) {
      const last = groups[groups.length - 1];
      if (last !== undefined && last[0]?.at === t.at) {
        last.push(t);
      } else {
        groups.push([t]);
      }
    }
    const shuffled = groups.toReversed().flat();
    expect(shuffled).not.toEqual(original);
    const a = scores('2026-01-01', '2026-06-30', busy());
    expect(a.full.loans).toBe(1);
    expect(a.full.bounces).toBe(1);
    expect(a.full.od_days).toBeGreaterThan(0);
    expect(scores('2026-01-01', '2026-06-30', shuffled)).toEqual(a);
  });

  it('keeps input order for equal timestamps, so swapping them changes od_days', () => {
    const neg = spend('2026-02-10', -5n);
    const pos = txn('2026-02-10', { credit: true, amount: 5n, bounce: true });
    expect(q1([neg, pos]).full.od_days).toBe(0);
    expect(q1([pos, neg]).full.od_days).toBe(19);
  });

  it('orders by time, not input position', () => {
    const early = spend('2026-01-10', -5n, 9);
    const late = txn('2026-01-10', { credit: true, amount: 5n, bounce: true, hour: 15 });
    expect(q1([late, early]).full.od_days).toBe(0);
  });
});

describe('ScoreError', () => {
  it('carries a FORMATS §10 code', () => {
    expect(new ScoreError('window_mismatch').code).toBe('window_mismatch');
    expect(new ScoreError('bad_fi_data').code).toBe('bad_fi_data');
  });
});
