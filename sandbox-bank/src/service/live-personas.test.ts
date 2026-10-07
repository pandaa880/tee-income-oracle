import { describe, expect, it } from 'vitest';

import { buildPersonas } from '../vectors/personas.ts';
import { personaFi } from './live-personas.ts';

const DAY = 86_400;
const MIDNIGHT = Date.UTC(2026, 9, 7) / 1000;

describe('personaFi', () => {
  it('is the persona built at the 00:00 UTC anchor of the day', () => {
    const expected = buildPersonas(MIDNIGHT).find((p) => p.persona_id === 'declining');
    expect(personaFi('declining', MIDNIGHT + 12 * 3600 + 345)).toEqual(expected?.fi);
  });

  it('gives the same statement all day and a new one the next day', () => {
    const morning = JSON.stringify(personaFi('stressed', MIDNIGHT + 60));
    const evening = JSON.stringify(personaFi('stressed', MIDNIGHT + DAY - 60));
    const tomorrow = JSON.stringify(personaFi('stressed', MIDNIGHT + DAY + 60));
    expect(evening).toBe(morning);
    expect(tomorrow).not.toBe(morning);
  });

  it('ends the statement on the day of the clock', () => {
    const fi = personaFi('salaried_steady', MIDNIGHT + 5 * DAY + 100) as {
      Transactions: { endDate: string };
    };
    expect(fi.Transactions.endDate).toBe('2026-10-12');
  });

  it('memoizes per persona and day', () => {
    expect(personaFi('trader_lumpy', MIDNIGHT + 1)).toBe(personaFi('trader_lumpy', MIDNIGHT + 2));
  });

  it('differs between personas', () => {
    expect(JSON.stringify(personaFi('salaried_steady', MIDNIGHT))).not.toBe(
      JSON.stringify(personaFi('trader_lumpy', MIDNIGHT)),
    );
  });
});
