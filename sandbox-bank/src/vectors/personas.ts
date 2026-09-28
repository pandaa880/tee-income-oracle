/**
 * The three borrower personas (FORMATS §1), generated from seeded specs so
 * nobody hand-edits 200 transactions. Money is integer paise throughout and
 * only formatted at the edge: `amount` as a JSON number with at most 2
 * decimals, balances as strings, as Finvu emits them.
 */

import type { JsonValue } from '../crypto/jcs.ts';
import { isoUtc } from '../rebit/key-material.ts';
import { createPrng, seedBytes, uuidFromSeed, type Prng } from './prng.ts';

export type PersonaId = 'salaried_steady' | 'trader_lumpy' | 'stressed';

export type Persona = {
  readonly persona_id: PersonaId;
  readonly description: string;
  readonly expected_tier: 'A' | 'B' | 'C';
  readonly fi: JsonValue;
};

/** Fixed generator clock, 2026-09-26T10:00:00.000Z (FORMATS §11). */
export const NOW_UNIX = 1_790_416_800;
const DAY = 86_400;

type TxnType = 'CREDIT' | 'DEBIT';
type Mode = 'CASH' | 'ATM' | 'CARD' | 'UPI' | 'FT' | 'OTHERS';
/** How an event behaves when the balance can't cover it. */
type Kind = 'always' | 'skip_if_short' | 'emi';

interface TxnEvent {
  readonly at: number; // unix seconds
  readonly type: TxnType;
  readonly mode: Mode;
  readonly paise: number;
  readonly narration: string;
  readonly kind: Kind;
}

interface Spec {
  readonly id: PersonaId;
  readonly description: string;
  readonly tier: 'A' | 'B' | 'C';
  readonly months: number;
  readonly accountType: 'SAVINGS' | 'CURRENT';
  readonly odLimitPaise: number; // 0 = no overdraft
  readonly openingPaise: number;
  readonly holder: { readonly name: string; readonly dob: string; readonly pan: string };
  readonly monthEvents: (monthStart: number, prng: Prng) => readonly TxnEvent[];
}

const SPECS: readonly Spec[] = [
  {
    id: 'salaried_steady',
    description: 'Salaried, one EMI, no bounces',
    tier: 'A',
    months: 12,
    accountType: 'SAVINGS',
    odLimitPaise: 0,
    openingPaise: 5_000_000,
    holder: { name: 'Asha Kulkarni', dob: '1991-04-12', pan: 'ABCPK1234F' },
    monthEvents: salariedMonth,
  },
  {
    id: 'trader_lumpy',
    description: 'Small trader, irregular large credits, one EMI',
    tier: 'B',
    months: 9,
    accountType: 'CURRENT',
    odLimitPaise: 0,
    openingPaise: 30_000_000,
    holder: { name: 'Ravi Shetty', dob: '1985-11-02', pan: 'BCDPS2345G' },
    monthEvents: traderMonth,
  },
  {
    id: 'stressed',
    description: 'Irregular salary, overdraft for weeks, EMI bounces',
    tier: 'C',
    months: 6,
    accountType: 'SAVINGS',
    odLimitPaise: 5_000_000,
    openingPaise: 200_000,
    holder: { name: 'Vikram Rao', dob: '1994-09-24', pan: 'CDEPR3456H' },
    monthEvents: stressedMonth,
  },
];

/** Personas in fixed order: salaried_steady, trader_lumpy, stressed. */
export function buildPersonas(): readonly Persona[] {
  return SPECS.map((spec) => ({
    persona_id: spec.id,
    description: spec.description,
    expected_tier: spec.tier,
    fi: buildFi(spec),
  }));
}

function buildFi(spec: Spec): JsonValue {
  const prng = createPrng(seedBytes(spec.id, 'persona'));
  const start = addMonths(dayStart(NOW_UNIX), -spec.months);
  const events = monthStarts(start, spec.months)
    .flatMap((m) => spec.monthEvents(m, prng))
    .filter((e) => e.at >= start && e.at <= NOW_UNIX)
    .toSorted((a, b) => a.at - b.at);
  const { transactions, closingPaise } = applyEvents(spec, events, prng);
  return {
    type: 'DEPOSIT',
    maskedAccNumber: `XXXXXXXX${String(prng.int(1000, 9999))}`,
    linkedAccRef: uuidFromSeed(seedBytes(spec.id, 'linkedAccRef')),
    version: '2.0',
    Profile: { Holders: { type: 'SINGLE', Holder: holder(spec) } },
    Summary: summary(spec, closingPaise),
    Transactions: {
      startDate: isoDate(start),
      endDate: isoDate(NOW_UNIX),
      Transaction: transactions,
    },
  };
}

/**
 * Walks events in time order keeping the balance. A spend the account can't
 * cover is skipped; an EMI it can't cover bounces (not debited, a return
 * charge is). The overdraft limit is how far below zero it may go.
 */
function applyEvents(
  spec: Spec,
  events: readonly TxnEvent[],
  prng: Prng,
): { transactions: JsonValue[]; closingPaise: number } {
  let balance = spec.openingPaise;
  const transactions: JsonValue[] = [];
  const post = (e: TxnEvent): void => {
    balance += e.type === 'CREDIT' ? e.paise : -e.paise;
    transactions.push(transaction(spec.id, transactions.length, e, balance, prng));
  };
  for (const e of events) {
    const short = e.type === 'DEBIT' && balance - e.paise < -spec.odLimitPaise;
    if (!short || e.kind === 'always') {
      post(e);
    } else if (e.kind === 'emi') {
      post({
        ...e,
        at: e.at + 60,
        paise: 59_000,
        narration: 'ACH RTN CHRG EMI BOUNCE',
        kind: 'always',
      });
    }
  }
  return { transactions, closingPaise: balance };
}

function transaction(
  id: PersonaId,
  seq: number,
  e: TxnEvent,
  balance: number,
  prng: Prng,
): JsonValue {
  return {
    type: e.type,
    mode: e.mode,
    amount: e.paise / 100,
    currentBalance: formatPaise(balance),
    transactionTimestamp: isoUtc(e.at),
    valueDate: isoDate(e.at),
    txnId: `${id.toUpperCase().slice(0, 3)}${String(seq + 1).padStart(6, '0')}`,
    narration: e.narration,
    reference: `REF${String(prng.int(10_000_000, 99_999_999))}`,
  };
}

function salariedMonth(m: number, prng: Prng): readonly TxnEvent[] {
  const events: TxnEvent[] = [
    ev(m, 1, prng, 'CREDIT', 'FT', 8_500_000, 'NEFT-SAL-ACME TECHNOLOGIES PVT LTD'),
    ev(m, 3, prng, 'DEBIT', 'UPI', 2_000_000, 'UPI-RENT-SHARMA PROPERTIES'),
    ev(m, 5, prng, 'DEBIT', 'OTHERS', 1_800_000, 'ACH-DR-HDFC HOME LOAN EMI', 'emi'),
    ev(m, prng.int(12, 18), prng, 'DEBIT', 'ATM', 500_000, 'ATM-WDL-PUNE CAMP'),
  ];
  for (let i = prng.int(6, 10); i > 0; i--) {
    events.push(spend(m, prng, 20_000, 300_000));
  }
  return events;
}

function traderMonth(m: number, prng: Prng): readonly TxnEvent[] {
  const events: TxnEvent[] = [
    ev(m, 10, prng, 'DEBIT', 'OTHERS', 2_500_000, 'ACH-DR-BAJAJ FIN BUSINESS LOAN EMI', 'emi'),
  ];
  for (let i = prng.int(2, 6); i > 0; i--) {
    const mode = prng.int(0, 1) === 0 ? 'UPI' : 'FT';
    const paise = prng.int(15_000, 250_000) * 100;
    events.push(ev(m, prng.int(1, 28), prng, 'CREDIT', mode, paise, `${mode}-CR-CUSTOMER PAYMENT`));
  }
  for (let i = prng.int(2, 5); i > 0; i--) {
    const paise = prng.int(10_000, 150_000) * 100;
    events.push(
      ev(m, prng.int(1, 28), prng, 'DEBIT', 'FT', paise, 'NEFT-DR-SUPPLIER', 'skip_if_short'),
    );
  }
  return events;
}

function stressedMonth(m: number, prng: Prng): readonly TxnEvent[] {
  const salary = prng.int(28_000, 34_000) * 100;
  const events: TxnEvent[] = [
    ev(m, prng.int(5, 15), prng, 'CREDIT', 'FT', salary, 'NEFT-SAL-QUICKSERVE STAFFING'),
    ev(m, 2, prng, 'DEBIT', 'UPI', 1_400_000, 'UPI-RENT-PG ACCOMMODATION', 'skip_if_short'),
    ev(m, 5, prng, 'DEBIT', 'OTHERS', 1_500_000, 'ACH-DR-PERSONAL LOAN EMI', 'emi'),
  ];
  for (let i = prng.int(10, 14); i > 0; i--) {
    events.push(spend(m, prng, 50_000, 250_000));
  }
  return events;
}

function spend(m: number, prng: Prng, minPaise: number, maxPaise: number): TxnEvent {
  const paise = prng.int(minPaise / 100, maxPaise / 100) * 100;
  return ev(m, prng.int(1, 28), prng, 'DEBIT', 'UPI', paise, 'UPI-DR-MERCHANT', 'skip_if_short');
}

function ev(
  monthStart: number,
  day: number,
  prng: Prng,
  type: TxnType,
  mode: Mode,
  paise: number,
  narration: string,
  kind: Kind = 'always',
): TxnEvent {
  const at = monthStart + (day - 1) * DAY + prng.int(8, 21) * 3600 + prng.int(0, 59) * 60;
  return { at, type, mode, paise, narration, kind };
}

function holder(spec: Spec): JsonValue {
  return {
    name: spec.holder.name,
    dob: spec.holder.dob,
    mobile: '9800000000',
    nominee: 'REGISTERED',
    email: `${spec.id}@example.in`,
    pan: spec.holder.pan,
    ckycCompliance: 'true',
  };
}

function summary(spec: Spec, closingPaise: number): JsonValue {
  return {
    currentBalance: formatPaise(closingPaise),
    currency: 'INR',
    balanceDateTime: isoUtc(NOW_UNIX),
    type: spec.accountType,
    branch: 'Pune',
    facility: spec.accountType === 'CURRENT' ? 'CC' : 'OD',
    ifscCode: 'SBIN0000454',
    micrCode: '411002001',
    openingDate: '2018-04-01',
    currentODLimit: formatPaise(spec.odLimitPaise),
    drawingLimit: formatPaise(spec.odLimitPaise),
    status: 'ACTIVE',
    Pending: { amount: 0 },
  };
}

/** Integer paise → "1234.50" / "-12.05". */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function monthStarts(start: number, months: number): number[] {
  return Array.from({ length: months + 1 }, (_, i) => addMonths(firstOfMonth(start), i));
}

function dayStart(unix: number): number {
  return unix - (unix % DAY);
}

function firstOfMonth(unix: number): number {
  const d = new Date(unix * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

function addMonths(unix: number, months: number): number {
  const d = new Date(unix * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()) / 1000;
}

function isoDate(unix: number): string {
  return isoUtc(unix).slice(0, 10);
}
