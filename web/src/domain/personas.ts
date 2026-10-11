// The four sandbox-bank accounts (FORMATS §1, §15). The cards show the story, never the tier.
import type { PersonaId, Tier } from './types.ts';

export type Persona = {
  id: PersonaId;
  title: string;
  description: string;
  /** What the account was built to score; shown only after the result, never on the card. */
  expectedTier: Tier | 'REJECT';
};

export const PERSONAS: readonly Persona[] = [
  {
    id: 'salaried_steady',
    title: 'Steady salary',
    description: 'Same employer credit every month, few bounces.',
    expectedTier: 'A',
  },
  {
    id: 'trader_lumpy',
    title: 'Lumpy trader',
    description: 'Large, irregular credits from many payers.',
    expectedTier: 'B',
  },
  {
    id: 'declining',
    title: 'Declining income',
    description: 'Credits shrink month after month.',
    expectedTier: 'C',
  },
  {
    id: 'stressed',
    title: 'Stressed account',
    description: 'Bounced payments and thin, uneven credits.',
    expectedTier: 'REJECT',
  },
];

/** Did the tier come out as the chosen test account was built to score? Null if unknown. */
export function matchesExpected(persona: PersonaId | null, tier: Tier): boolean | null {
  const found = PERSONAS.find((p) => p.id === persona);
  return found === undefined ? null : found.expectedTier === tier;
}
