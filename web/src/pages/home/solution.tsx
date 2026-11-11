import type { Capability } from '../../domain/roadmap.ts';
import { RoadmapBadge } from './roadmap-badge.tsx';
import { SectionBand } from './section-band.tsx';
import { SectionHeading } from './section-heading.tsx';

const CARDS: readonly { title: string; body: string; capability: Capability }[] = [
  {
    title: 'Every loan gets a receipt.',
    body: 'Checked against the borrower’s own bank data, under the pool’s eligibility criteria.',
    capability: 'bank_receipt',
  },
  {
    title: 'The whole pool, not a sample.',
    body: 'You see which loans have a receipt and which don’t.',
    capability: 'loan_id_receipts',
  },
  {
    title: 'Repayments checked every month.',
    body: 'The bank shows whether the EMIs the NBFC reports were really paid.',
    capability: 'repayment_check',
  },
];

/** 02: what TIO adds, in three plain claims, each marked with how far along it is. */
export function Solution() {
  return (
    <SectionBand id="solution" labelledBy="solution-h" tinted>
      <SectionHeading
        id="solution-h"
        kicker="02 · The solution"
        title="TIO puts the borrower’s bank between the NBFC and the funder."
      />
      <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-3">
        {CARDS.map((card) => (
          <li
            key={card.title}
            className="flex flex-col gap-3 rounded-sm border border-border bg-background p-5"
          >
            <h3 className="font-display text-xl leading-tight">{card.title}</h3>
            <p className="text-lg text-muted-foreground">{card.body}</p>
            <div className="mt-auto">
              <RoadmapBadge capability={card.capability} />
            </div>
          </li>
        ))}
      </ul>
    </SectionBand>
  );
}
