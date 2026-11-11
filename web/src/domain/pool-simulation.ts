// The landing's "put bad loans in the pool" simulation. Fixed, illustrative inputs: an NBFC's
// loan tape of 1,240 loans, a 99% baseline match between the EMIs the tape reports and the EMIs
// the borrowers' banks confirm, and example thresholds a funder might write into a facility.
// A bad loan is one the bank can't confirm: it is refused before funding, and it pulls the
// tape's match rate down, which is what the facility's rules act on. Nothing here is read from
// chain; the page labels it a simulation.

export const BAD_LOAN_SHARES = [0, 2, 5, 10, 20] as const;

/** Percent of the pool's reported loans that aren't what the tape says. */
export type BadLoanShare = (typeof BAD_LOAN_SHARES)[number];

export type RuleBand = 'open' | 'stop_drawdowns' | 'trap_cash';

export type PoolSimulation = {
  /** Loans refused before money moves (they have no receipt or no payout). */
  blocked: number;
  /** Percent of reported EMIs the borrower's bank confirms. */
  matchRate: number;
  band: RuleBand;
  /** Where the match rate sits on the band, 0 (top, 100%) to 100 (bottom, 80% or less). */
  markerPct: number;
};

export const SIM_POOL_SIZE = 1240;
export const SIM_BASE_MATCH = 99;
export const RULE_THRESHOLDS = { stopDrawdowns: 95, trapCash: 90 } as const;

/** The band's scale runs from 100% at the top to this match rate at the bottom. */
export const BAND_FLOOR = 80;

/**
 * A match rate as one-decimal text ("94.1%"). Rounds through whole hundredths first, so a
 * floating-point 94.05 (stored as 94.0499…) still shows as 94.1, like the arithmetic says.
 */
export function formatMatchRate(matchRate: number): string {
  const hundredths = Math.round(matchRate * 100);
  return `${(Math.round(hundredths / 10) / 10).toFixed(1)}%`;
}

/** The example rule a match rate triggers: at or above 95% open, at or above 90% stop, else trap. */
export function ruleBand(matchRate: number): RuleBand {
  if (matchRate >= RULE_THRESHOLDS.stopDrawdowns) return 'open';
  if (matchRate >= RULE_THRESHOLDS.trapCash) return 'stop_drawdowns';
  return 'trap_cash';
}

/** Each bad loan is refused before funding, and its reported EMIs drop out of the tape's match. */
export function simulatePool(share: BadLoanShare): PoolSimulation {
  const matchRate = SIM_BASE_MATCH * (1 - share / 100);
  const markerPct = ((100 - matchRate) / (100 - BAND_FLOOR)) * 100;
  return {
    blocked: Math.round((SIM_POOL_SIZE * share) / 100),
    matchRate,
    band: ruleBand(matchRate),
    markerPct: Math.min(100, Math.max(0, markerPct)),
  };
}
