import { TONES } from '@tio/ui/tokens';
import { describe, expect, it } from 'vitest';
import { tierTone } from './tier-tone.ts';

describe('tierTone', () => {
  it('maps the tiers to the agreed tones', () => {
    expect(tierTone('A')).toBe('positive');
    expect(tierTone('B')).toBe('caution');
    expect(tierTone('REJECT')).toBe('negative');
  });

  it('gives tier C a tone of its own that is not the tier A tone', () => {
    expect(TONES).toContain(tierTone('C'));
    expect(tierTone('C')).not.toBe(tierTone('A'));
  });
});
