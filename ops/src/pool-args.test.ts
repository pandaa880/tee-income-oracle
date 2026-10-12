import { describe, expect, it } from 'vitest';
import { parsePoolId, parseTierLimits } from './pool-args.ts';
import { ONE_TOKEN, POOL_DEFAULTS } from './pool-setup.ts';

describe('parsePoolId', () => {
  it('defaults_to_pool_zero_when_absent', () => {
    expect(parsePoolId(undefined)).toBe(0);
  });

  it.each([
    ['0', 0],
    ['1', 1],
    ['255', 255],
  ])('accepts_%s', (raw, id) => {
    expect(parsePoolId(raw)).toBe(id);
  });

  it.each([
    ['one_above_the_u8_range', '256'],
    ['negative', '-1'],
    ['not_a_number', 'x'],
    ['not_an_integer', '1.5'],
    ['empty', ''],
  ])('rejects_%s', (_name, raw) => {
    expect(() => parsePoolId(raw)).toThrow(expect.objectContaining({ code: 'invalid_pool_id' }));
  });
});

describe('parseTierLimits', () => {
  it('defaults_to_the_pool_defaults_when_absent', () => {
    expect([...parseTierLimits(undefined)]).toEqual([...POOL_DEFAULTS.tierLimits]);
  });

  it('applies_six_decimals_to_whole_tokens', () => {
    expect([...parseTierLimits('3000,1000,0')]).toEqual([3000n * ONE_TOKEN, 1000n * ONE_TOKEN, 0n]);
  });

  it('parses_the_default_values_to_the_default_limits', () => {
    expect([...parseTierLimits('5000,2000,500')]).toEqual([...POOL_DEFAULTS.tierLimits]);
  });

  it('accepts_equal_limits_and_a_zero_c', () => {
    expect([...parseTierLimits('7,7,7')]).toEqual([7n * ONE_TOKEN, 7n * ONE_TOKEN, 7n * ONE_TOKEN]);
  });

  it.each([
    ['two_parts', '3000,1000'],
    ['four_parts', '1,2,3,4'],
    ['negative', '-1,0,0'],
    ['non_integer', '1.5,1,0'],
    ['not_numbers', 'a,b,c'],
    ['a_is_zero', '0,0,0'],
    ['b_above_a', '1000,3000,0'],
    ['c_above_b', '3000,0,1000'],
    ['empty', ''],
    ['a_above_u64_in_base_units', '18446744073710,0,0'],
  ])('rejects_%s', (_name, raw) => {
    expect(() => parseTierLimits(raw)).toThrow(
      expect.objectContaining({ code: 'invalid_tier_limits' }),
    );
  });
});
