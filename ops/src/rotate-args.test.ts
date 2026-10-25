import { describe, expect, it } from 'vitest';
import { OpsError } from './errors.ts';
import { parseKeepActive } from './rotate-args.ts';

describe('parseKeepActive', () => {
  it('defaults_to_keeping_nothing', () => {
    expect(parseKeepActive(undefined)).toEqual([]);
  });

  it.each([
    ['1', [1]],
    ['0', [0]],
    ['254', [254]],
    ['3,1', [1, 3]],
    ['1,1', [1]],
  ])('parses_%s', (raw, ids) => {
    expect(parseKeepActive(raw)).toEqual(ids);
  });

  it.each(['', 'a', '1,', ',1', '-1', '255', '1.5', ' 1', '1;2'])('rejects_%j', (raw) => {
    expect(() => parseKeepActive(raw)).toThrow(OpsError);
    expect(() => parseKeepActive(raw)).toThrow(/--keep-active must be/);
  });
});
