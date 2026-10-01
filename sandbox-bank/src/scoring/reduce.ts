/**
 * ReBIT DEPOSIT FI JSON text → the minimal transactions the scorer needs
 * (FORMATS §1, §6.1). Money is read from the exact JSON number/string text
 * (no float, no rounding); narration is reduced to two flags.
 *
 * Reads the generator's own output shape (`Transactions.Transaction[]`), not
 * every spelling a real FIP may send: the enclave's lenient parser is
 * `tio-core/src/rebit.rs`.
 */

export interface MiniTxn {
  readonly credit: boolean;
  /** Paise, never negative. */
  readonly amount: bigint;
  /** Paise after this transaction; negative = overdrawn. */
  readonly balance: bigint;
  /** Unix seconds (UTC instant). */
  readonly at: number;
  readonly bounce: boolean;
  readonly emiWord: boolean;
}

export interface MiniFi {
  /** `startDate` as written, days since 1970-01-01 (read as an India date). */
  readonly startDay: number;
  /** `endDate` as written, inclusive. */
  readonly endDay: number;
  readonly txns: readonly MiniTxn[];
}

/** Same token sets as `tio-core/src/rebit.rs`. */
import { daysFromCivil } from './calendar.ts';

const BOUNCE_TOKENS = new Set(['RTN', 'RETURN', 'RETURNED', 'BOUNCE', 'INSUFF']);
const EMI_TOKENS = new Set(['EMI', 'LOAN', 'NACH', 'ECS']);

const DAY_S = 86_400;

type Reviver = (key: string, value: unknown, context?: { readonly source?: string }) => unknown;

/**
 * Every JSON number becomes its source text (ES2026 JSON.parse source
 * access, Node >= 21), so money never passes through a float.
 */
const keepNumberText: Reviver = (_key, value, context) =>
  typeof value === 'number' && context?.source !== undefined ? context.source : value;

const parseKeepingNumberText = JSON.parse as (json: string, reviver: Reviver) => unknown;

export function reduceFi(fiJsonText: string): MiniFi {
  const transactions = field(parseKeepingNumberText(fiJsonText, keepNumberText), 'Transactions');
  const list = field(transactions, 'Transaction');
  if (!Array.isArray(list)) {
    throw new Error('Transactions.Transaction is not an array');
  }
  return {
    startDay: dayNumber(stringField(transactions, 'startDate')),
    endDay: dayNumber(stringField(transactions, 'endDate')),
    txns: list.map(reduceTxn),
  };
}

function reduceTxn(t: unknown): MiniTxn {
  const narration = field(t, 'narration');
  const tokens = new Set(
    // ASCII-only split, then upper-case the ASCII tokens (as rebit.rs does):
    // upper-casing first would map e.g. 'ı' or 'ſ' onto ASCII letters.
    (typeof narration === 'string' ? narration : '')
      .split(/[^A-Za-z0-9]+/)
      .map((w) => w.toUpperCase()),
  );
  const has = (set: ReadonlySet<string>): boolean => [...tokens].some((token) => set.has(token));
  return {
    credit: /^CREDIT$/i.test(stringField(t, 'type')),
    amount: decimalToPaise(stringField(t, 'amount')),
    balance: decimalToPaise(stringField(t, 'currentBalance')),
    at: unixSeconds(stringField(t, 'transactionTimestamp')),
    bounce: has(BOUNCE_TOKENS),
    emiWord: has(EMI_TOKENS),
  };
}

/** `value[key]` when `value` is a JSON object, else undefined. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const v: unknown = Reflect.get(value, key);
  return v;
}

/** A required string field (numbers arrive as their source text). */
function stringField(value: unknown, key: string): string {
  const v = field(value, key);
  if (typeof v !== 'string') {
    throw new Error(`missing or non-string field ${key}`);
  }
  return v;
}

/** Exact decimal text (`1234.05`, `1.2E7`, `-12.05`) → paise. */
export function decimalToPaise(text: string): bigint {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  const [, sign = '', whole = '', frac = '', exp = '0'] = m ?? [];
  if (m === null || whole + frac === '') {
    throw new Error(`not a decimal: ${text}`);
  }
  const scale = Number(exp) - frac.length + 2;
  const digits = BigInt(whole + frac);
  let paise: bigint;
  if (scale >= 0) {
    paise = digits * 10n ** BigInt(scale);
  } else {
    const divisor = 10n ** BigInt(-scale);
    if (digits % divisor !== 0n) {
      throw new Error(`not a whole number of paise: ${text}`);
    }
    paise = digits / divisor;
  }
  return sign === '-' ? -paise : paise;
}

/** ReBIT timestamp with `Z`, `±HH:MM`, `±HHMM` or no zone (= UTC) → unix seconds. */
function unixSeconds(text: string): number {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):?(\d{2}))?$/.exec(
      text,
    );
  if (m === null) {
    throw new Error(`not a ReBIT timestamp: ${text}`);
  }
  const [, y, mo, d, h, mi, s, , sign, oh = '0', om = '0'] = m;
  const local =
    daysFromCivil(Number(y), Number(mo), Number(d)) * DAY_S +
    Number(h) * 3600 +
    Number(mi) * 60 +
    Number(s);
  const offset = (Number(oh) * 60 + Number(om)) * 60 * (sign === '-' ? -1 : 1);
  return local - offset;
}

/** Written date `YYYY-MM-DD` (zone ignored) → days since 1970-01-01. */
function dayNumber(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (m === null) {
    throw new Error(`not a date: ${date}`);
  }
  const [, y, mo, d] = m;
  return daysFromCivil(Number(y), Number(mo), Number(d));
}
