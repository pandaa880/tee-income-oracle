import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from './amount.ts';

describe('parseAmount', () => {
  it.each([
    ['12', 12_000_000n],
    ['1.5', 1_500_000n],
    ['0.000001', 1n],
    ['123.456789', 123_456_789n],
    ['  12.5  ', 12_500_000n],
    ['18446744073709.551615', 18_446_744_073_709_551_615n], // u64::MAX base units
  ])('accepts %j as %s base units', (text, expected) => {
    expect(parseAmount(text)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['0', 'zero'],
    ['0.000000', 'zero'],
    ['-1', 'negative'],
    ['-0.5', 'negative'],
    ['1.1234567', 'too_many_decimals'],
    ['1e3', 'not_a_number'],
    ['abc', 'not_a_number'],
    ['1,5', 'not_a_number'],
    ['1.2.3', 'not_a_number'],
  ])('rejects %j as %s', (text, reason) => {
    expect(parseAmount(text)).toEqual({ ok: false, error: { code: 'invalid_amount', reason } });
  });

  it('honours the decimals argument', () => {
    expect(parseAmount('1.25', 2)).toEqual({ ok: true, value: 125n });
    expect(parseAmount('1.255', 2)).toMatchObject({
      ok: false,
      error: { code: 'invalid_amount', reason: 'too_many_decimals' },
    });
  });

  it('rejects anything above u64::MAX even without a limit (it could not be encoded)', () => {
    expect(parseAmount('18446744073709.551616')).toEqual({
      ok: false,
      error: { code: 'invalid_amount', reason: 'over_limit' },
    });
  });

  it('accepts exactly the limit and rejects one base unit above it', () => {
    expect(parseAmount('5', 6, 5_000_000n)).toEqual({ ok: true, value: 5_000_000n });
    expect(parseAmount('5.000001', 6, 5_000_000n)).toEqual({
      ok: false,
      error: { code: 'invalid_amount', reason: 'over_limit' },
    });
  });
});

describe('formatAmount', () => {
  it.each([
    [0n, '0'],
    [1n, '0.000001'],
    [1_500_000n, '1.5'],
    [12_000_000n, '12'],
    [123_456_789n, '123.456789'],
    [9_999_999_999_999_999_999_000_001n, '9999999999999999999.000001'],
  ])('formats %s as %j', (value, text) => {
    expect(formatAmount(value)).toBe(text);
  });

  it('honours the decimals argument', () => {
    expect(formatAmount(1n, 2)).toBe('0.01');
    expect(formatAmount(500n, 2)).toBe('5');
    expect(formatAmount(7n, 0)).toBe('7');
  });

  it('round-trips with parseAmount', () => {
    for (const text of ['1', '0.5', '0.000001', '42.123456', '1000000']) {
      const parsed = parseAmount(text);
      expect(parsed.ok && formatAmount(parsed.value)).toBe(text);
    }
  });
});
