import { describe, expect, it } from 'vitest';
import {
  BAD_LOAN_SHARES,
  BAND_FLOOR,
  RULE_THRESHOLDS,
  SIM_BASE_MATCH,
  SIM_POOL_SIZE,
  type BadLoanShare,
  type RuleBand,
  formatMatchRate,
  ruleBand,
  simulatePool,
} from './pool-simulation.ts';

const EXPECTED: [BadLoanShare, number, number, RuleBand][] = [
  [0, 0, 99, 'open'],
  [2, 25, 97.02, 'open'],
  [5, 62, 94.05, 'stop_drawdowns'],
  [10, 124, 89.1, 'trap_cash'],
  [20, 248, 79.2, 'trap_cash'],
];

describe('pool-simulation constants', () => {
  it('offers the five bad-loan shares in ascending order', () => {
    expect(BAD_LOAN_SHARES).toEqual([0, 2, 5, 10, 20]);
  });

  it('fixes the pool size, base match rate and rule thresholds', () => {
    expect(SIM_POOL_SIZE).toBe(1240);
    expect(SIM_BASE_MATCH).toBe(99);
    expect(RULE_THRESHOLDS).toEqual({ stopDrawdowns: 95, trapCash: 90 });
  });
});

describe('simulatePool', () => {
  it.each(EXPECTED)(
    'at %s%% bad loans blocks %s, matches %s%%, band %s',
    (share, blocked, match, band) => {
      const result = simulatePool(share);
      expect(result.blocked).toBe(blocked);
      expect(result.matchRate).toBeCloseTo(match, 6);
      expect(result.band).toBe(band);
    },
  );

  it('keeps markerPct within 0-100 for every share', () => {
    for (const share of BAD_LOAN_SHARES) {
      const { markerPct } = simulatePool(share);
      expect(markerPct).toBeGreaterThanOrEqual(0);
      expect(markerPct).toBeLessThanOrEqual(100);
    }
  });

  it('clamps the 20% marker to 100', () => {
    expect(simulatePool(20).markerPct).toBe(100);
  });

  it('puts the 0% marker at 5, i.e. (100 - 99) / 20 of the band', () => {
    expect(simulatePool(0).markerPct).toBeCloseTo(5, 6);
  });

  it('moves the marker down the band as the bad-loan share grows', () => {
    const markers = BAD_LOAN_SHARES.map((share) => simulatePool(share).markerPct);
    for (let i = 1; i < markers.length; i += 1) {
      expect(markers[i]).toBeGreaterThan(markers[i - 1] ?? Infinity);
    }
  });
});

describe('ruleBand', () => {
  it.each<[number, RuleBand]>([
    [95, 'open'],
    [94.99, 'stop_drawdowns'],
    [90, 'stop_drawdowns'],
    [89.99, 'trap_cash'],
  ])('puts a %s%% match rate in band %s', (matchRate, band) => {
    expect(ruleBand(matchRate)).toBe(band);
  });
});

describe('formatMatchRate', () => {
  it.each<[number, string]>([
    [99, '99.0%'],
    [97.02, '97.0%'],
    [99 * 0.95, '94.1%'],
    [99 * 0.9, '89.1%'],
    [99 * 0.8, '79.2%'],
  ])('shows %s as %s', (matchRate, text) => {
    expect(formatMatchRate(matchRate)).toBe(text);
  });

  it('formats every simulated share without floating-point noise', () => {
    const shown = BAD_LOAN_SHARES.map((share) => formatMatchRate(simulatePool(share).matchRate));
    expect(shown).toEqual(['99.0%', '97.0%', '94.1%', '89.1%', '79.2%']);
  });
});

describe('BAND_FLOOR', () => {
  it('ends the band at 80%, under both thresholds', () => {
    expect(BAND_FLOOR).toBe(80);
    expect(BAND_FLOOR).toBeLessThan(RULE_THRESHOLDS.trapCash);
  });
});
