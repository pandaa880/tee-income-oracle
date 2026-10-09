// Token amounts as bigint base units. No floats anywhere: `Number("0.1")` can't hold money.
import type { AmountProblem, Result } from './types.ts';

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Token amounts are u64 on chain; anything above can't be encoded into an instruction. */
const U64_MAX = 2n ** 64n - 1n;

const invalid = (reason: AmountProblem): Result<never> => ({
  ok: false,
  error: { code: 'invalid_amount', reason },
});

/** Parses user text like "12.5" into base units; `max` is inclusive. */
export function parseAmount(text: string, decimals = 6, max?: bigint): Result<bigint> {
  const trimmed = text.trim();
  if (trimmed === '') return invalid('empty');
  const match = DECIMAL.exec(trimmed);
  if (match === null) return invalid('not_a_number');
  const [, sign = '', whole = '', fraction = ''] = match;
  if (sign === '-') return invalid('negative');
  if (fraction.length > decimals) return invalid('too_many_decimals');
  const value = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (value === 0n) return invalid('zero');
  if (value > (max ?? U64_MAX)) return invalid('over_limit');
  return { ok: true, value };
}

/** Formats base units for display, trimming trailing zeros ("1.5", "12", "0.000001"). */
export function formatAmount(value: bigint, decimals = 6): string {
  if (decimals === 0) return value.toString();
  const digits = value.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}
