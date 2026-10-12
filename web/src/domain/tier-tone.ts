import type { Tone } from '@tio/ui/tokens';
import type { Tier } from './types.ts';

/** As the design tokens colour them: A green, B blue, C ochre (`--tier-a/b/c`). */
const TIER_TONE: Record<Tier | 'REJECT', Tone> = {
  A: 'positive',
  B: 'info',
  C: 'caution',
  REJECT: 'negative',
};

/** The only place a tier becomes a colour role; `@tio/ui` never knows what a tier is. */
export function tierTone(tier: Tier | 'REJECT'): Tone {
  return TIER_TONE[tier];
}
