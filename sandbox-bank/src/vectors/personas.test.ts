import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reduceFi } from '../scoring/reduce.ts';
import { score } from '../scoring/score.ts';
import { NOW_UNIX, buildPersonas, type Persona } from './personas.ts';
import { DEFAULT_POLICY } from './policy.ts';

interface FinvuTransaction {
  readonly type: string;
  readonly mode: string;
  readonly amount: number;
  readonly currentBalance: string;
  readonly transactionTimestamp: string;
  readonly narration?: string;
}

interface FinvuFi {
  readonly type: string;
  readonly version: string;
  readonly Profile: {
    readonly Holders: {
      readonly type: string;
      readonly Holder: { readonly nominee: string };
    };
  };
  readonly Summary: {
    readonly type: string;
    readonly facility?: string;
    readonly status: string;
  };
  readonly Transactions: {
    readonly startDate: string;
    readonly endDate: string;
    readonly Transaction: readonly FinvuTransaction[];
  };
}

function isoDay(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function dayNumber(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000;
}

function asFi(persona: Persona): FinvuFi {
  return persona.fi as unknown as FinvuFi;
}

function decimalPlaces(n: number): number {
  const s = n.toString();
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

// Paise (integer, 2dp) parsed from a balance/amount string or number without
// ever going through a float, per FORMATS §1 "parse from raw JSON text into
// integer paise; never through f64".
function toPaise(value: string | number): bigint {
  const s = typeof value === 'number' ? value.toFixed(2) : value;
  const negative = s.startsWith('-');
  const unsigned = negative ? s.slice(1) : s;
  const [whole = '0', frac = '00'] = unsigned.split('.');
  const paddedFrac = (frac + '00').slice(0, 2);
  const paise = BigInt(whole) * 100n + BigInt(paddedFrac);
  return negative ? -paise : paise;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function monthsBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

describe('buildPersonas', () => {
  const personas = buildPersonas();

  it('returns exactly 4 personas in the fixed order', () => {
    expect(personas.map((p) => p.persona_id)).toEqual([
      'salaried_steady',
      'trader_lumpy',
      'declining',
      'stressed',
    ]);
  });

  it('assigns the expected tiers A, B, C and REJECT in order', () => {
    expect(personas.map((p) => p.expected_tier)).toEqual(['A', 'B', 'C', 'REJECT']);
  });

  it('is deterministic: calling it twice produces deep-equal output', () => {
    expect(buildPersonas()).toEqual(buildPersonas());
  });

  describe.each(personas.map((p) => [p.persona_id, p] as const))('persona %s', (_id, persona) => {
    const fi = asFi(persona);

    it('has the Finvu DEPOSIT shape', () => {
      expect(fi.type).toBe('DEPOSIT');
      expect(fi.version).toBe('2.0');
      expect(typeof fi.Profile.Holders).toBe('object');
      expect(Array.isArray(fi.Transactions.Transaction)).toBe(true);
      expect(fi.Transactions.Transaction.length).toBeGreaterThan(0);
    });

    it('uses only FORMATS §1 enum values', () => {
      expect(['SINGLE', 'JOINT']).toContain(fi.Profile.Holders.type);
      expect(['REGISTERED', 'NOT-REGISTERED']).toContain(fi.Profile.Holders.Holder.nominee);
      expect(['SAVINGS', 'CURRENT']).toContain(fi.Summary.type);
      if (fi.Summary.facility !== undefined) {
        expect(['OD', 'CC']).toContain(fi.Summary.facility);
      }
      expect(['ACTIVE', 'INACTIVE']).toContain(fi.Summary.status);
      for (const txn of fi.Transactions.Transaction) {
        expect(['CREDIT', 'DEBIT']).toContain(txn.type);
        expect(['CASH', 'ATM', 'CARD', 'UPI', 'FT', 'OTHERS']).toContain(txn.mode);
      }
    });

    it('has amounts as numbers with at most 2 decimal places', () => {
      for (const txn of fi.Transactions.Transaction) {
        expect(typeof txn.amount).toBe('number');
        expect(decimalPlaces(txn.amount)).toBeLessThanOrEqual(2);
      }
    });

    it('has amounts and balances with non-zero paise, so the money parser is exercised', () => {
      const txns = fi.Transactions.Transaction;
      expect(txns.some((t) => decimalPlaces(t.amount) > 0)).toBe(true);
      expect(txns.some((t) => !t.currentBalance.endsWith('.00'))).toBe(true);
    });

    it('has balances as strings with exactly 2 decimal places', () => {
      for (const txn of fi.Transactions.Transaction) {
        expect(typeof txn.currentBalance).toBe('string');
        expect(txn.currentBalance).toMatch(/^-?\d+\.\d{2}$/);
      }
    });

    it('has transactions sorted by transactionTimestamp', () => {
      const timestamps = fi.Transactions.Transaction.map((t) =>
        new Date(t.transactionTimestamp).getTime(),
      );
      for (let i = 1; i < timestamps.length; i += 1) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1] as number);
      }
    });

    it('has a running balance consistent with signed transaction amounts (integer paise)', () => {
      const txns = fi.Transactions.Transaction;
      for (let i = 1; i < txns.length; i += 1) {
        const prev = txns[i - 1];
        const curr = txns[i];
        if (prev === undefined || curr === undefined) {
          continue;
        }
        const delta = toPaise(curr.currentBalance) - toPaise(prev.currentBalance);
        const signedAmount = curr.type === 'CREDIT' ? toPaise(curr.amount) : -toPaise(curr.amount);
        expect(delta).toBe(signedAmount);
      }
    });
  });

  it('salaried_steady spans about 12 months', () => {
    const fi = asFi(required(personas[0], 'expected persona 0'));
    expect(
      Math.abs(monthsBetween(fi.Transactions.startDate, fi.Transactions.endDate) - 12),
    ).toBeLessThanOrEqual(1);
  });

  it('trader_lumpy spans about 9 months', () => {
    const fi = asFi(required(personas[1], 'expected persona 1'));
    expect(
      Math.abs(monthsBetween(fi.Transactions.startDate, fi.Transactions.endDate) - 9),
    ).toBeLessThanOrEqual(1);
  });

  it('declining spans about 12 months', () => {
    const fi = asFi(required(personas[2], 'expected persona 2'));
    expect(
      Math.abs(monthsBetween(fi.Transactions.startDate, fi.Transactions.endDate) - 12),
    ).toBeLessThanOrEqual(1);
  });

  it('stressed spans about 6 months', () => {
    const fi = asFi(required(personas[3], 'expected persona 3'));
    expect(
      Math.abs(monthsBetween(fi.Transactions.startDate, fi.Transactions.endDate) - 6),
    ).toBeLessThanOrEqual(1);
  });

  it('salaried_steady has no bounce narration (one EMI, no bounces)', () => {
    const fi = asFi(required(personas[0], 'expected persona 0'));
    for (const txn of fi.Transactions.Transaction) {
      expect(txn.narration ?? '').not.toMatch(/bounce/i);
    }
  });

  it('salaried_steady has an amount under one rupee (no rupee part)', () => {
    const fi = asFi(required(personas[0], 'expected persona 0'));
    expect(fi.Transactions.Transaction.some((t) => t.amount < 1)).toBe(true);
  });

  it('declining has no negative running balance (no overdraft)', () => {
    const fi = asFi(required(personas[2], 'expected persona 2'));
    expect(fi.Transactions.Transaction.every((t) => toPaise(t.currentBalance) >= 0n)).toBe(true);
  });

  it('stressed has at least one negative running balance', () => {
    const fi = asFi(required(personas[3], 'expected persona 3'));
    expect(fi.Transactions.Transaction.some((t) => toPaise(t.currentBalance) < 0n)).toBe(true);
  });

  describe('scored with the default policy by the independent TS scorer', () => {
    const policy = DEFAULT_POLICY;
    const scored = (persona: Persona) => score(reduceFi(JSON.stringify(persona.fi)), policy);

    it.each(personas.map((p) => [p.persona_id, p] as const))(
      '%s scores to its expected_tier',
      (_id, persona) => {
        expect(scored(persona).outcome).toBe(persona.expected_tier);
      },
    );

    it('declining: full window B-shaped, recent window C-shaped, one explained bounce', () => {
      const { full, recent } = scored(required(personas[2], 'expected persona 2'));
      expect(full.bounces).toBe(1);
      expect(recent.bounces).toBe(1);
      expect(full.foir_bps).toBeLessThanOrEqual(5500);
      expect(full.cv_bps).toBeLessThanOrEqual(5000);
      expect(recent.foir_bps).toBeGreaterThan(5500);
      expect(recent.foir_bps).toBeLessThanOrEqual(7000);
      expect([full.loans, recent.loans]).toEqual([1, 1]);
      expect(full.unmatched_emi_bounces).toBe(0);
      expect(recent.unmatched_emi_bounces).toBe(0);
      expect(full.od_days).toBeLessThan(30);
    });

    it('stressed: loan measured, uncured bounces unmatched, weeks of overdraft', () => {
      const { full } = scored(required(personas[3], 'expected persona 3'));
      expect(full.loans).toBe(1);
      expect(full.unmatched_emi_bounces).toBeGreaterThan(0);
      expect(full.od_days).toBeGreaterThanOrEqual(30);
      expect(full.bounces).toBeGreaterThan(3);
    });
  });
});

describe('buildPersonas anchor (live bank re-anchors the statement each day)', () => {
  const DAY = 86_400;
  const FIRST_ANCHOR = Date.UTC(2026, 9, 7) / 1000; // 2026-10-07T00:00:00Z
  const SWEEP_DAYS = 400;

  // sha256 of JSON.stringify(fi) of the pre-anchor generator, so `pnpm gen:vectors` stays byte-identical.
  const DEFAULT_FI_SHA256: Record<string, string> = {
    salaried_steady: 'da58939e519e9017db96d92916e22c23ba23a0977a9a36710db0db96bf04de5e',
    trader_lumpy: '893adefe714b220b395b42ba5b83d92c7fbc67d5a583bc0f6ba626ed0df1bf0b',
    declining: 'a9c03560da2e02b0a6a1f02f8cb26916633ad94bea32d8588ead9156f5f4838f',
    stressed: 'f128b88b4a8b451f67e6b6f4d3aeab54c410bf68ae2aef6cbc8940b868fb477a',
  };

  it('the default anchor is NOW_UNIX: no argument equals buildPersonas(NOW_UNIX)', () => {
    expect(buildPersonas()).toEqual(buildPersonas(NOW_UNIX));
  });

  it('the default output is unchanged by the anchor parameter (pinned hashes)', () => {
    const hashes = Object.fromEntries(
      buildPersonas().map((p) => [
        p.persona_id,
        createHash('sha256').update(JSON.stringify(p.fi)).digest('hex'),
      ]),
    );
    expect(hashes).toEqual(DEFAULT_FI_SHA256);
  });

  it('a different anchor gives a different statement', () => {
    const today = buildPersonas(FIRST_ANCHOR).map((p) => JSON.stringify(p.fi));
    const tomorrow = buildPersonas(FIRST_ANCHOR + DAY).map((p) => JSON.stringify(p.fi));
    expect(tomorrow).not.toEqual(today);
  });

  it('is deterministic per anchor', () => {
    expect(buildPersonas(FIRST_ANCHOR + 17 * DAY)).toEqual(buildPersonas(FIRST_ANCHOR + 17 * DAY));
  });

  it('keeps the persona order and expected tiers for any anchor', () => {
    const personas = buildPersonas(FIRST_ANCHOR + 100 * DAY);
    expect(personas.map((p) => [p.persona_id, p.expected_tier])).toEqual([
      ['salaried_steady', 'A'],
      ['trader_lumpy', 'B'],
      ['declining', 'C'],
      ['stressed', 'REJECT'],
    ]);
  });

  it('ends the statement on the anchor day', () => {
    const anchor = FIRST_ANCHOR + 40 * DAY;
    for (const p of buildPersonas(anchor)) {
      expect(asFi(p).Transactions.endDate).toBe(isoDay(anchor));
    }
  });

  it('starts at most 365 days before the anchor, whatever the month lengths', () => {
    // 2028-03-01 minus 12 calendar months is 366 days (the leap day); 2027-08-31 is a 365-day control.
    for (const anchor of [Date.UTC(2028, 2, 1) / 1000, Date.UTC(2027, 7, 31) / 1000]) {
      for (const p of buildPersonas(anchor)) {
        const startDay = dayNumber(asFi(p).Transactions.startDate);
        expect(startDay).toBeGreaterThanOrEqual(anchor / DAY - 365);
      }
    }
  });

  it('has no transaction after the anchor', () => {
    const anchor = FIRST_ANCHOR + 3 * DAY;
    for (const p of buildPersonas(anchor)) {
      const last = asFi(p).Transactions.Transaction.at(-1);
      expect(new Date(last?.transactionTimestamp ?? 0).getTime()).toBeLessThanOrEqual(
        anchor * 1000,
      );
    }
  });

  it(`every day for ${SWEEP_DAYS} days: tier, end date, start clamp, no late txn, long enough`, () => {
    const failures: string[] = [];
    for (let d = 0; d < SWEEP_DAYS; d += 1) {
      const anchor = FIRST_ANCHOR + d * DAY;
      for (const p of buildPersonas(anchor)) {
        const fi = asFi(p);
        const label = `${isoDay(anchor)} ${p.persona_id}`;
        const { startDate, endDate, Transaction: txns } = fi.Transactions;
        const tier = score(reduceFi(JSON.stringify(p.fi)), DEFAULT_POLICY).outcome;
        if (tier !== p.expected_tier) failures.push(`${label}: tier ${tier}`);
        if (endDate !== isoDay(anchor)) failures.push(`${label}: endDate ${endDate}`);
        if (dayNumber(startDate) < anchor / DAY - 365)
          failures.push(`${label}: start ${startDate}`);
        if (dayNumber(endDate) - dayNumber(startDate) < DEFAULT_POLICY.window.min_days) {
          failures.push(`${label}: statement ${startDate}..${endDate} shorter than policy minimum`);
        }
        const late = txns.filter((t) => new Date(t.transactionTimestamp).getTime() > anchor * 1000);
        if (late.length > 0) failures.push(`${label}: ${late.length} txn after anchor`);
        if (txns.length === 0) failures.push(`${label}: no transactions`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('buildPersonas across the leap-day clamp', () => {
  it('keeps every tier on the days where the 365-day clamp moves the start (Feb–Mar 2028)', () => {
    const failures: string[] = [];
    for (let d = 0; d < 45; d += 1) {
      const anchor = Date.UTC(2028, 1, 15) / 1000 + d * 86_400;
      for (const p of buildPersonas(anchor)) {
        const tier = score(reduceFi(JSON.stringify(p.fi)), DEFAULT_POLICY).outcome;
        if (tier !== p.expected_tier) {
          failures.push(`${isoDay(anchor)} ${p.persona_id}: tier ${tier}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
