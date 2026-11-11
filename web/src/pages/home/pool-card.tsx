import type { Capability } from '../../domain/roadmap.ts';
import { RoadmapBadge } from './roadmap-badge.tsx';

const ROWS: readonly { label: string; value: string; capability: Capability }[] = [
  { label: 'Loan is real', value: 'bank receipt', capability: 'bank_receipt' },
  { label: 'Money was paid out', value: 'seen in bank', capability: 'payout_proof' },
  { label: 'EMIs were paid', value: 'seen in bank', capability: 'repayment_check' },
  { label: 'Anything that doesn’t match', value: 'flagged to you', capability: 'mismatch_flags' },
  { label: 'Rule state', value: 'drawdowns open', capability: 'pool_rules' },
];

/**
 * What a funder would see for one pool: one line per check, each marked with its stage. The
 * figcaption names it simulated; nothing here is read from chain, so it makes no live claim.
 */
export function PoolCard() {
  return (
    <figure
      aria-labelledby="pool-card-caption"
      className="m-0 flex w-full max-w-md flex-col gap-4 border border-t-2 border-border border-t-rule-strong bg-card p-5"
    >
      <p className="m-0 border-b-3 border-double border-rule-strong pb-2 font-mono text-sm tracking-(--tracking-caps) uppercase">
        Pool A · NBFC loans
      </p>
      <dl className="m-0 flex flex-col">
        {ROWS.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border py-2.5"
          >
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="m-0 flex flex-wrap items-center gap-2">
              {row.value}
              <RoadmapBadge capability={row.capability} />
            </dd>
          </div>
        ))}
      </dl>
      <figcaption id="pool-card-caption" className="text-sm text-muted-foreground">
        Simulated pool · illustrative
      </figcaption>
    </figure>
  );
}
