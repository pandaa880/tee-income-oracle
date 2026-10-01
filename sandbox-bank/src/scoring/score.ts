/**
 * Independent TypeScript scorer (FORMATS §6.1). Written from the spec text,
 * not from the Rust code, so the two implementations can catch each other's
 * mistakes. Money is bigint paise; days are India calendar days. The i64 and
 * u128 limits of the Rust scorer are checked explicitly so both raise the
 * same overflow errors.
 */

import { daysFromCivil } from './calendar.ts';
import type { MiniFi, MiniTxn } from './reduce.ts';

export type Outcome = 'A' | 'B' | 'C' | 'REJECT';

export interface TierRule {
  readonly tier: 'A' | 'B' | 'C';
  readonly foir_max_bps: number;
  readonly cv_max_bps: number;
  readonly bounces_max: number;
}

/** The scoring-relevant part of a v2 policy (FORMATS §6). */
export interface PolicyV2 {
  readonly recurrence: {
    readonly amount_tol_bps: number;
    readonly day_tol: number;
    readonly min_occurrences: number;
  };
  readonly recent_months: number;
  readonly tiers: readonly TierRule[];
  readonly reject_if: { readonly od_days_min: number };
}

export interface Features {
  readonly months: number;
  readonly income_median_paise: bigint;
  readonly obligation_median_paise: bigint;
  readonly foir_bps: number;
  readonly cv_bps: number;
  readonly loans: number;
  readonly bounces: number;
  readonly unmatched_emi_bounces: number;
  readonly od_days: number;
}

export interface Scores {
  readonly outcome: Outcome;
  readonly full: Features;
  readonly recent: Features;
}

/** Thrown for the two §6.1 errors; `code` is the FORMATS §10 error code. */
export class ScoreError extends Error {
  readonly code: 'window_mismatch' | 'bad_fi_data';

  constructor(code: 'window_mismatch' | 'bad_fi_data') {
    super(code);
    this.name = 'ScoreError';
    this.code = code;
  }
}

const IST_OFFSET_S = 19_800;
const DAY_S = 86_400;
const DAY_MS = 86_400_000;
const I64_MAX = 2n ** 63n - 1n;
const U128_MAX = 2n ** 128n - 1n;
const U32_MAX = 2 ** 32 - 1;
const OUTCOME_ORDER: readonly Outcome[] = ['A', 'B', 'C', 'REJECT'];

interface Entry {
  readonly day: number;
  readonly month: number; // year * 12 + month - 1
  readonly dom: number;
  readonly txn: MiniTxn;
}

interface Loan {
  readonly scheduled: bigint;
  readonly firstDay: number;
  /** Day of month of the first payment: the due day a bounce must match. */
  readonly dueDom: number;
  readonly paidMonths: ReadonlySet<number>;
}

interface Span {
  readonly first: number;
  readonly last: number;
}

interface Month {
  readonly key: number;
  readonly span: Span;
}

export function score(fi: MiniFi, policy: PolicyV2): Scores {
  const entries = orderedEntries(fi);
  const loans = findLoans(entries, policy.recurrence);
  const months = completeMonths(fi.startDay, fi.endDay);
  const recentMonths = months.slice(Math.max(0, months.length - policy.recent_months));
  const dayTol = policy.recurrence.day_tol;
  const statement = { first: fi.startDay, last: fi.endDay };
  const full = features(entries, loans, months, statement, dayTol);
  const recent = features(entries, loans, recentMonths, spanOf(recentMonths), dayTol);
  const worse = Math.max(
    OUTCOME_ORDER.indexOf(outcomeOf(full, policy)),
    OUTCOME_ORDER.indexOf(outcomeOf(recent, policy)),
  );
  return { outcome: OUTCOME_ORDER[worse] ?? 'REJECT', full, recent };
}

/** Bounds check (step 0), then sort by timestamp keeping input order on ties. */
function orderedEntries(fi: MiniFi): Entry[] {
  return fi.txns
    .map((txn) => {
      const day = Math.floor((txn.at + IST_OFFSET_S) / DAY_S);
      if (day < fi.startDay || day > fi.endDay) {
        throw new ScoreError('window_mismatch');
      }
      const date = new Date(day * DAY_MS);
      const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
      return { day, month, dom: date.getUTCDate(), txn };
    })
    .toSorted((a, b) => a.txn.at - b.txn.at);
}

type Kind = 'income' | 'candidate' | 'bounce' | 'emi_bounce' | 'ignored';

function kindOf(t: MiniTxn): Kind {
  if (!t.credit && t.bounce) {
    return t.emiWord ? 'emi_bounce' : 'bounce';
  }
  if (!t.credit && t.emiWord) {
    // A zero-amount debit is never a loan payment.
    return t.amount > 0n ? 'candidate' : 'ignored';
  }
  return t.credit && !t.bounce ? 'income' : 'ignored';
}

/** Step 2: anchor-based clusters, at most one member per month. */
function findLoans(entries: readonly Entry[], rec: PolicyV2['recurrence']): Loan[] {
  const candidates = entries.filter((e) => kindOf(e.txn) === 'candidate');
  const taken = new Set<number>();
  const loans: Loan[] = [];
  candidates.forEach((anchor, i) => {
    if (taken.has(i)) {
      return;
    }
    taken.add(i);
    const members = [anchor];
    for (let j = i + 1; j < candidates.length; j++) {
      const c = candidates[j];
      if (c === undefined || taken.has(j) || !matches(anchor, c, rec)) {
        continue;
      }
      if (members.every((m) => m.month !== c.month)) {
        taken.add(j);
        members.push(c);
      }
    }
    if (members.length >= rec.min_occurrences) {
      loans.push({
        scheduled: median(members.map((m) => m.txn.amount)),
        firstDay: anchor.day,
        dueDom: anchor.dom,
        paidMonths: new Set(members.map((m) => m.month)),
      });
    }
  });
  return loans;
}

function matches(anchor: Entry, c: Entry, rec: PolicyV2['recurrence']): boolean {
  const diff = c.txn.amount - anchor.txn.amount;
  const absDiff = diff < 0n ? -diff : diff;
  return (
    absDiff * 10_000n <= anchor.txn.amount * BigInt(rec.amount_tol_bps) &&
    Math.abs(c.dom - anchor.dom) <= rec.day_tol
  );
}

function monthSpan(key: number): Span {
  const year = Math.floor(key / 12);
  const month = key - year * 12 + 1; // 1–12
  const next = month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, month + 1, 1);
  return { first: daysFromCivil(year, month, 1), last: next - 1 };
}

function monthKey(day: number): number {
  const date = new Date(day * DAY_MS);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/** Step 3: calendar months wholly inside [start, end]. */
function completeMonths(start: number, end: number): Month[] {
  const months: Month[] = [];
  for (let key = monthKey(start); key <= monthKey(end); key++) {
    const span = monthSpan(key);
    if (span.first >= start && span.last <= end) {
      months.push({ key, span });
    }
  }
  return months;
}

function spanOf(months: readonly Month[]): Span | undefined {
  const first = months[0];
  const last = months.at(-1);
  return first && last ? { first: first.span.first, last: last.span.last } : undefined;
}

/** Steps 4–5 for one set of months; `span` = days for bounces / OD days. */
function features(
  entries: readonly Entry[],
  loans: readonly Loan[],
  months: readonly Month[],
  span: Span | undefined,
  dayTol: number,
): Features {
  const incomes = months.map((m) =>
    checkedSum(
      entries.filter((e) => e.month === m.key && kindOf(e.txn) === 'income'),
      (e) => e.txn.amount,
    ),
  );
  const obligations = months.map((m) =>
    checkedSum(
      loans.filter((l) => l.firstDay <= m.span.last),
      (l) => l.scheduled,
    ),
  );
  const cv = cvBps(incomes);
  const incomeMedian = median(incomes);
  const obligationMedian = median(obligations);
  const inSpan = (e: Entry): boolean =>
    span !== undefined && e.day >= span.first && e.day <= span.last;
  return {
    months: months.length,
    income_median_paise: incomeMedian,
    obligation_median_paise: obligationMedian,
    foir_bps: foirBps(obligationMedian, incomeMedian),
    cv_bps: cv,
    loans: span === undefined ? 0 : loans.filter((l) => l.firstDay <= span.last).length,
    bounces: entries.filter((e) => inSpan(e) && kindOf(e.txn).endsWith('bounce')).length,
    unmatched_emi_bounces: unmatchedEmiBounces(
      entries.filter((e) => inSpan(e) && kindOf(e.txn) === 'emi_bounce'),
      loans,
      dayTol,
    ),
    od_days: span === undefined ? 0 : odDays(entries, span),
  };
}

function checkedSum<T>(items: readonly T[], value: (item: T) => bigint): bigint {
  let sum = 0n;
  for (const item of items) {
    sum += value(item);
    if (sum > I64_MAX) {
      throw new ScoreError('bad_fi_data');
    }
  }
  return sum;
}

/**
 * EMI bounces no known loan explains. A loan explains a bounce if it started
 * by the end of the bounce's month, has no payment that month, and is due
 * within `dayTol` days of the bounce's day of month; each loan explains at
 * most one bounce per month (first unclaimed loan, bounces in time order).
 */
function unmatchedEmiBounces(
  emiBounces: readonly Entry[],
  loans: readonly Loan[],
  dayTol: number,
): number {
  const claimed = new Map<number, Set<Loan>>(); // month key → loans already used
  let unmatched = 0;
  for (const b of emiBounces) {
    const used = claimed.get(b.month) ?? new Set<Loan>();
    claimed.set(b.month, used);
    const monthEnd = monthSpan(b.month).last;
    // Eligible: unclaimed, started by month end, missed this month, due
    // within dayTol, and cured (paid again in a later month). Earliest due
    // day wins (first on ties), which pairs every bounce when possible.
    const eligible = loans.filter(
      (l) =>
        !used.has(l) &&
        l.firstDay <= monthEnd &&
        !l.paidMonths.has(b.month) &&
        Math.abs(l.dueDom - b.dom) <= dayTol &&
        [...l.paidMonths].some((m) => m > b.month),
    );
    const loan = eligible.reduce<Loan | undefined>(
      (best, l) => (best === undefined || l.dueDom < best.dueDom ? l : best),
      undefined,
    );
    if (loan === undefined) {
      unmatched += 1;
    } else {
      used.add(loan);
    }
  }
  return unmatched;
}

/** Days in `span` whose end-of-day balance (last txn on or before) is negative. */
function odDays(entries: readonly Entry[], span: Span): number {
  let days = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const next = entries[i + 1];
    if (e === undefined || (next !== undefined && next.day === e.day)) {
      continue; // not the day's last transaction
    }
    if (e.txn.balance < 0n) {
      const until = next === undefined ? Number.MAX_SAFE_INTEGER : next.day - 1;
      days += Math.max(0, Math.min(until, span.last) - Math.max(e.day, span.first) + 1);
    }
  }
  return days;
}

function median(values: readonly bigint[]): bigint {
  const sorted = values.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) {
    return 0n;
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const sum = (sorted[mid - 1] ?? upper) + upper;
  return sum >= 0n ? sum / 2n : -((-sum + 1n) / 2n); // floor
}

function isqrt(n: bigint): bigint {
  if (n < 2n) {
    return n;
  }
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** `v`, or bad_fi_data where the Rust scorer's u128 arithmetic overflows. */
function u128(v: bigint): bigint {
  if (v > U128_MAX) {
    throw new ScoreError('bad_fi_data');
  }
  return v;
}

/** floor(isqrt(1e8 * (n*Σx² - (Σx)²)) / Σx), with u128 limits. */
function cvBps(incomes: readonly bigint[]): number {
  let sum = 0n;
  let sumSq = 0n;
  for (const x of incomes) {
    sum = u128(sum + x);
    sumSq = u128(sumSq + u128(x * x));
  }
  if (sum === 0n) {
    return 0;
  }
  const n = BigInt(incomes.length);
  const spread = u128(u128(u128(n * sumSq) - u128(sum * sum)) * 100_000_000n);
  const cv = isqrt(spread) / sum;
  if (cv > BigInt(U32_MAX)) {
    throw new ScoreError('bad_fi_data');
  }
  return Number(cv);
}

function foirBps(obligation: bigint, income: bigint): number {
  if (income <= 0n) {
    return 0;
  }
  const ratio = (obligation * 10_000n) / income;
  return ratio >= BigInt(U32_MAX) ? U32_MAX : Number(ratio);
}

/** Step 6: fixed Reject order, then the first matching tier. */
function outcomeOf(f: Features, policy: PolicyV2): Outcome {
  if (
    f.months === 0 ||
    f.income_median_paise <= 0n ||
    f.foir_bps === U32_MAX ||
    f.unmatched_emi_bounces > 0 ||
    f.od_days >= policy.reject_if.od_days_min
  ) {
    return 'REJECT';
  }
  const rule = policy.tiers.find(
    (t) => f.foir_bps <= t.foir_max_bps && f.cv_bps <= t.cv_max_bps && f.bounces <= t.bounces_max,
  );
  return rule?.tier ?? 'REJECT';
}
