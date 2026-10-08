import { describe, expect, it } from 'vitest';
import { clearMeasurementBit, hasMeasurementBit, setMeasurementBit } from './bitmap.ts';

const empty = () => new Uint8Array(32);

describe('setMeasurementBit', () => {
  it.each([
    [0, 0, 0b0000_0001],
    [1, 0, 0b0000_0010],
    [7, 0, 0b1000_0000],
    [8, 1, 0b0000_0001],
    [254, 31, 0b0100_0000],
  ])('id_%i_sets_byte_%i_to_%i_LSB_first', (id, byte, value) => {
    const result = setMeasurementBit(empty(), id);
    expect(result[byte]).toBe(value);
    expect(result.filter((b) => b !== 0)).toHaveLength(1);
  });

  it('returns_a_new_array_and_leaves_the_input_unchanged', () => {
    const input = empty();
    const result = setMeasurementBit(input, 3);
    expect(result).not.toBe(input);
    expect(input).toEqual(empty());
  });

  it('keeps_other_bits', () => {
    const result = setMeasurementBit(setMeasurementBit(empty(), 0), 9);
    expect(hasMeasurementBit(result, 0)).toBe(true);
    expect(hasMeasurementBit(result, 9)).toBe(true);
    expect(hasMeasurementBit(result, 1)).toBe(false);
  });

  it('is_idempotent', () => {
    const once = setMeasurementBit(empty(), 5);
    expect(setMeasurementBit(once, 5)).toEqual(once);
  });
});

describe('clearMeasurementBit', () => {
  it.each([0, 7, 8, 254])('clears_id_%i', (id) => {
    expect(clearMeasurementBit(setMeasurementBit(empty(), id), id)).toEqual(empty());
  });

  it('returns_a_new_array_and_leaves_the_input_unchanged', () => {
    const input = setMeasurementBit(empty(), 4);
    const copy = new Uint8Array(input);
    const result = clearMeasurementBit(input, 4);
    expect(result).not.toBe(input);
    expect(input).toEqual(copy);
  });

  it('leaves_other_bits', () => {
    const both = setMeasurementBit(setMeasurementBit(empty(), 1), 2);
    const result = clearMeasurementBit(both, 1);
    expect(hasMeasurementBit(result, 1)).toBe(false);
    expect(hasMeasurementBit(result, 2)).toBe(true);
  });

  it('is_a_no_op_for_an_unset_bit', () => {
    expect(clearMeasurementBit(empty(), 100)).toEqual(empty());
  });
});

describe('hasMeasurementBit', () => {
  it('reads_the_documented_position', () => {
    const bitmap = empty();
    bitmap[1] = 0b0000_0100; // id 10
    expect(hasMeasurementBit(bitmap, 10)).toBe(true);
    expect(hasMeasurementBit(bitmap, 9)).toBe(false);
  });
});

describe('input validation', () => {
  it.each([0, 31, 33, 64])('rejects_a_%i_byte_bitmap', (length) => {
    const bad = new Uint8Array(length);
    expect(() => setMeasurementBit(bad, 0)).toThrow(/bitmap must be 32 bytes/);
    expect(() => clearMeasurementBit(bad, 0)).toThrow(/bitmap must be 32 bytes/);
    expect(() => hasMeasurementBit(bad, 0)).toThrow(/bitmap must be 32 bytes/);
  });

  it.each([-1, 255, 256, 1.5, Number.NaN])('rejects_id_%s', (id) => {
    expect(() => setMeasurementBit(empty(), id)).toThrow(/measurement id must be an integer/);
    expect(() => clearMeasurementBit(empty(), id)).toThrow(/measurement id must be an integer/);
  });
});
