import { TONES } from '@tio/ui/tokens';
import { describe, expect, it } from 'vitest';
import { tierTone } from './tier-tone.ts';

describe('tierTone', () => {
  it('maps the tiers to the tones the design tokens give them (--tier-a/b/c)', () => {
    expect(tierTone('A')).toBe('positive');
    expect(tierTone('B')).toBe('info');
    expect(tierTone('C')).toBe('caution');
    expect(tierTone('REJECT')).toBe('negative');
  });

  it('gives every tier a tone of its own', () => {
    const tones = (['A', 'B', 'C', 'REJECT'] as const).map(tierTone);
    tones.forEach((tone) => expect(TONES).toContain(tone));
    expect(new Set(tones).size).toBe(4);
  });
});
