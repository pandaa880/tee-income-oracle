import { Badge } from '@tio/ui/badge';
import { cn } from '@tio/ui/cn';
import { TONE_TEXT, type Tone } from '@tio/ui/tokens';
import { useState } from 'react';
import {
  BAD_LOAN_SHARES,
  type BadLoanShare,
  type PoolSimulation,
  type RuleBand,
  formatMatchRate,
  simulatePool,
} from '../../domain/pool-simulation.ts';
import { RulesBand } from './rules-band.tsx';
import { SectionBand } from './section-band.tsx';
import { SectionHeading } from './section-heading.tsx';

const BAND: Record<RuleBand, { label: string; tone: Tone }> = {
  open: { label: 'Drawdowns open', tone: 'positive' },
  stop_drawdowns: { label: 'New drawdowns stopped', tone: 'caution' },
  trap_cash: { label: 'Collections trapped · senior paid first', tone: 'negative' },
};

/**
 * The two sentences under the outcome: the facility without TIO, and with it. The "with" line
 * names the step between the two halves: refused loans pull the tape's match rate down, and the
 * facility's rule acts on that rate (an open band fires nothing).
 */
function outcomeLines(sim: PoolSimulation): { without: string; with: string } {
  if (sim.blocked === 0) {
    return {
      without: 'Nothing to find.',
      with: 'Every loan on the tape carries a receipt, and drawdowns stay open.',
    };
  }
  const refused = `The bank can’t confirm ${sim.blocked} loans on the tape. They’re refused before funding`;
  const rate = formatMatchRate(sim.matchRate);
  return {
    without: `${sim.blocked} loans on the tape look fine until an audit, months after the money is gone.`,
    with:
      sim.band === 'open'
        ? `${refused}; the tape’s match rate holds at ${rate}, so drawdowns stay open.`
        : `${refused}, the tape’s match rate falls to ${rate}, and the facility’s rule fires: ${BAND[sim.band].label.toLowerCase()}.`,
  };
}

/** One short sentence for screen readers, announced whole after each pick. */
function summary(share: BadLoanShare, sim: PoolSimulation): string {
  const rule = BAND[sim.band].label.toLowerCase();
  return `${share}% bad loans: ${sim.blocked} blocked before funding, match rate ${formatMatchRate(sim.matchRate)}, ${rule}.`;
}

const STAT_LABEL = 'font-mono text-sm tracking-(--tracking-caps) text-muted-foreground uppercase';

/** 03: pick a share of bad loans, see what is blocked and which example rule fires. */
export function PoolSimulator() {
  const [share, setShare] = useState<BadLoanShare>(2);
  const sim = simulatePool(share);
  const band = BAND[sim.band];
  const lines = outcomeLines(sim);
  return (
    <SectionBand id="rules" labelledBy="rules-h">
      <SectionHeading
        id="rules-h"
        kicker="03 · The rules"
        title="The funder sets the rules. They act before money moves."
      />
      <div className="flex flex-col gap-6 rounded-sm border border-rule-strong bg-card p-5 md:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="font-display text-xl leading-tight">
            Put bad loans in the pool and watch what happens.
          </h3>
          <Badge variant="outline" tone="caution">
            Simulation
          </Badge>
        </div>
        <div
          role="group"
          aria-label="Share of bad loans in the pool"
          className="flex flex-wrap gap-2"
        >
          {BAD_LOAN_SHARES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === share}
              onClick={() => setShare(option)}
              className={cn(
                'min-h-11 min-w-16 rounded-sm border px-4 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                option === share
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-transparent text-foreground hover:bg-muted',
              )}
            >
              {`${option}%`}
            </button>
          ))}
        </div>
        <p aria-live="polite" aria-atomic="true" className="sr-only">
          {summary(share, sim)}
        </p>
        <div className="flex flex-col gap-4 border-t-3 border-double border-rule-strong pt-4">
          <div className="flex flex-wrap gap-x-12 gap-y-4">
            <p className="m-0 flex flex-col gap-1">
              <span className={STAT_LABEL}>Loans blocked before money moves</span>
              <strong className="font-display text-3xl leading-none text-tone-positive">
                {String(sim.blocked)}
              </strong>
            </p>
            <p className="m-0 flex flex-col gap-1">
              <span className={STAT_LABEL}>Facility status</span>
              <span className={cn('font-display text-2xl leading-tight', TONE_TEXT[band.tone])}>
                {band.label}
              </span>
            </p>
          </div>
          <p className="m-0 text-lg">
            <strong>Without TIO:</strong> {lines.without}
          </p>
          <p className="m-0 text-lg">
            <strong>With TIO:</strong> {lines.with}
          </p>
        </div>
      </div>
      <RulesBand markerPct={sim.markerPct} matchRate={formatMatchRate(sim.matchRate)} />
    </SectionBand>
  );
}
