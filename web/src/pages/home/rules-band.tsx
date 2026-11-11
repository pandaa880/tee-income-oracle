import { Table, TableBody, TableCell, TableHead, TableRow } from '@tio/ui/table';
import { TONE_TINT } from '@tio/ui/tokens';
import { BAND_FLOOR, RULE_THRESHOLDS } from '../../domain/pool-simulation.ts';
import { isBuilt, stageOf } from '../../domain/roadmap.ts';
import { RoadmapBadge } from './roadmap-badge.tsx';

const { stopDrawdowns, trapCash } = RULE_THRESHOLDS;

/** The band runs from 100% match (top) to `BAND_FLOOR` (bottom); each zone's height is its span. */
const ZONES = [
  {
    name: 'Healthy',
    note: 'drawdowns continue',
    span: 100 - stopDrawdowns,
    tint: TONE_TINT.positive,
  },
  {
    name: 'Warning',
    note: `below ${stopDrawdowns}%`,
    span: stopDrawdowns - trapCash,
    tint: TONE_TINT.caution,
  },
  {
    name: 'Trouble',
    note: `below ${trapCash}%`,
    span: trapCash - BAND_FLOOR,
    tint: TONE_TINT.negative,
  },
] as const;

const RULES = [
  [
    'No receipt or no payout',
    'The loan can’t enter the pool. The NBFC replaces it or buys it back.',
  ],
  [`Match rate below ${stopDrawdowns}%`, 'New drawdowns stop until the gap is explained.'],
  [`Match rate below ${trapCash}%`, 'Collections are trapped. Senior funders are paid first.'],
  ['Consent revoked', 'The loan is flagged for review. A revocation is a signal too.'],
] as const;

/** The lowest the marker is drawn, in percent of the bar's height. */
const MARKER_MAX = 98;

/** Whether the rules exist yet comes from the roadmap, never from hand-typed copy. */
const RULES_NOTE = isBuilt(stageOf('pool_rules')) ? '' : ' Planned, not built.';

export type RulesBandProps = {
  /** Where the current match rate sits on the band, 0–100 from the top. */
  markerPct: number;
  /** The current match rate as text ("97.0%"). */
  matchRate: string;
};

/** The match-rate band with a "now" marker, beside the example rules a funder could write. */
export function RulesBand({ markerPct, matchRate }: RulesBandProps) {
  // Held just inside the bar, so a clamped 100 isn't half-clipped by the bar's bottom edge.
  const at = { top: `${Math.min(markerPct, MARKER_MAX)}%` };
  return (
    <div className="grid grid-cols-1 gap-10 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <figure aria-label={`Match-rate band, now at ${matchRate}`} className="m-0 flex h-80 gap-3">
        <div className="relative flex w-14 shrink-0 flex-col overflow-hidden rounded-sm border border-rule-strong">
          {ZONES.map((zone) => (
            <div key={zone.name} className={zone.tint} style={{ flexGrow: zone.span }} />
          ))}
          <span
            aria-hidden="true"
            className="absolute inset-x-0 h-0.5 -translate-y-1/2 bg-foreground"
            style={at}
          />
        </div>
        <div className="relative w-28 shrink-0">
          <span
            className="absolute left-0 -translate-y-1/2 font-mono text-sm font-medium whitespace-nowrap"
            style={at}
          >
            <span aria-hidden="true">◀ </span>now · {matchRate}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {ZONES.map((zone) => (
            <div key={zone.name} className="flex flex-col pt-1" style={{ flexGrow: zone.span }}>
              <span className="font-semibold">{zone.name}</span>
              <span className="text-sm text-muted-foreground">{zone.note}</span>
            </div>
          ))}
        </div>
      </figure>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 id="example-rules-h" className="font-display text-xl leading-tight">
            Example rules
          </h3>
          <RoadmapBadge capability="pool_rules" />
        </div>
        <Table aria-labelledby="example-rules-h" className="text-lg">
          <TableBody>
            {RULES.map(([when, then]) => (
              <TableRow key={when}>
                <TableHead scope="row" className="align-top md:w-60">
                  {when}
                </TableHead>
                <TableCell className="text-muted-foreground">{then}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-muted-foreground">
          Example thresholds. Each funder writes its own into the deal. On Solana the pool’s program
          would enforce them; off chain, the trustee.{RULES_NOTE}
        </p>
      </div>
    </div>
  );
}
