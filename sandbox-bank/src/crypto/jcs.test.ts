import { describe, expect, it } from 'vitest';
import { canonicalize } from './jcs.ts';

describe('canonicalize', () => {
  it('sorts object keys by UTF-16 code unit', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts keys recursively in nested objects', () => {
    const value = { z: { d: 1, c: 2 }, a: 1 };
    expect(canonicalize(value)).toBe('{"a":1,"z":{"c":2,"d":1}}');
  });

  it('keeps array element order (arrays are never sorted)', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('keeps array order inside an object value', () => {
    expect(canonicalize({ v: [2, 1] })).toBe('{"v":[2,1]}');
  });

  it('reproduces the FORMATS §6 policy example canonical bytes', () => {
    const policy = {
      v: 2,
      recurrence: { amount_tol_bps: 1000, day_tol: 5, min_occurrences: 3 },
      recent_months: 3,
      window: { min_days: 180, max_age_days: 7 },
      tiers: [
        { tier: 'A', foir_max_bps: 4000, cv_max_bps: 1500, bounces_max: 0 },
        { tier: 'B', foir_max_bps: 5500, cv_max_bps: 5000, bounces_max: 1 },
        { tier: 'C', foir_max_bps: 7000, cv_max_bps: 6000, bounces_max: 3 },
      ],
      reject_if: { od_days_min: 30 },
    };
    expect(canonicalize(policy)).toBe(
      '{"recent_months":3,"recurrence":{"amount_tol_bps":1000,"day_tol":5,"min_occurrences":3},' +
        '"reject_if":{"od_days_min":30},' +
        '"tiers":[{"bounces_max":0,"cv_max_bps":1500,"foir_max_bps":4000,"tier":"A"},' +
        '{"bounces_max":1,"cv_max_bps":5000,"foir_max_bps":5500,"tier":"B"},' +
        '{"bounces_max":3,"cv_max_bps":6000,"foir_max_bps":7000,"tier":"C"}],' +
        '"v":2,"window":{"max_age_days":7,"min_days":180}}',
    );
  });

  it('escapes strings exactly like JSON.stringify', () => {
    const s = 'a"b\nc\\d\ttab';
    expect(canonicalize({ s })).toBe(`{"s":${JSON.stringify(s)}}`);
  });

  it('passes through booleans and null unchanged', () => {
    expect(canonicalize({ a: true, b: false, c: null })).toBe('{"a":true,"b":false,"c":null}');
  });

  it('rejects a non-integer number', () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow();
  });

  it('rejects an unsafe integer', () => {
    expect(() => canonicalize({ a: 2 ** 53 })).toThrow();
  });

  it('accepts the largest safe integer', () => {
    expect(canonicalize({ a: Number.MAX_SAFE_INTEGER })).toBe(`{"a":${Number.MAX_SAFE_INTEGER}}`);
  });

  it('rejects a non-integer number nested inside an array', () => {
    expect(() => canonicalize([1, 2.5, 3])).toThrow();
  });
});
