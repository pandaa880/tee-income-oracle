import { describe, expect, it } from 'vitest';
import { daysFromCivil } from './calendar.ts';

describe('daysFromCivil', () => {
  it('is 0 at the unix epoch', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
  });

  it('matches known dates around a leap day', () => {
    expect(daysFromCivil(2026, 1, 1)).toBe(20_454);
    expect(daysFromCivil(2024, 3, 1) - daysFromCivil(2024, 2, 28)).toBe(2);
    expect(daysFromCivil(2100, 3, 1) - daysFromCivil(2100, 2, 28)).toBe(1);
  });

  it('keeps years 0–99 as written (Date.UTC would map them to 1900–1999)', () => {
    expect(daysFromCivil(0, 3, 1)).toBe(-719_468);
    expect(daysFromCivil(1999, 1, 1) - daysFromCivil(99, 1, 1)).toBe(1900 * 365 + 460);
  });
});
