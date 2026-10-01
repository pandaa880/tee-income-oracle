import { describe, expect, it } from 'vitest';
import { reduceFi } from '../scoring/reduce.ts';
import { score } from '../scoring/score.ts';
import { buildPersonas, type Persona } from './personas.ts';
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

    it('stressed: rejected for EMI bounces with no known loan', () => {
      const { full } = scored(required(personas[3], 'expected persona 3'));
      expect(full.unmatched_emi_bounces).toBeGreaterThan(0);
    });
  });
});
