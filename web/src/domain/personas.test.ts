import { describe, expect, it } from 'vitest';
import { PERSONAS } from './personas.ts';

describe('PERSONAS', () => {
  it('lists the four PersonaIds in the board order', () => {
    expect(PERSONAS.map((p) => p.id)).toEqual([
      'salaried_steady',
      'trader_lumpy',
      'declining',
      'stressed',
    ]);
  });

  it('titles the accounts by their story', () => {
    expect(PERSONAS.map((p) => p.title)).toEqual([
      'Steady salary',
      'Lumpy trader',
      'Declining income',
      'Stressed account',
    ]);
  });

  it('records the tier each account is built to score (FORMATS §1)', () => {
    expect(PERSONAS.map((p) => p.expectedTier)).toEqual(['A', 'B', 'C', 'REJECT']);
  });

  it.each(PERSONAS.map((p) => [p.id, p] as const))(
    '%s gives no hint of the expected tier in its copy',
    (_, persona) => {
      expect(persona.title).not.toMatch(/\b(tier [ABC]|REJECT)\b/i);
      expect(persona.description).not.toMatch(/\b(tier [ABC]|REJECT)\b/i);
      expect(persona.description.length).toBeGreaterThan(0);
    },
  );
});
