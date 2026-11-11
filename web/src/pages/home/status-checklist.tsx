import { Link } from '@tanstack/react-router';
import { Button } from '@tio/ui/button';
import { ProofBar, type ProofBarProps } from '@tio/ui/proof-bar';
import type { Capability } from '../../domain/roadmap.ts';
import { RoadmapBadge } from './roadmap-badge.tsx';
import { SectionBand } from './section-band.tsx';
import { SectionHeading } from './section-heading.tsx';

const ITEMS: readonly { text: string; capability: Capability }[] = [
  { text: 'Blind check of bank data inside an enclave', capability: 'enclave_check' },
  { text: 'Receipts on Solana, read by the demo pools', capability: 'receipts_on_chain' },
  { text: 'Open source, reproducible build', capability: 'open_source_build' },
  { text: 'Verify page and loan book', capability: 'verify_and_book' },
  { text: 'Receipts keyed to the NBFC’s loan ID', capability: 'loan_id_receipts' },
  { text: 'Proof the loan was paid out', capability: 'payout_proof' },
  { text: 'Monthly repayment check', capability: 'repayment_check' },
  { text: 'Rules that stop drawdowns or trap cash', capability: 'pool_rules' },
  { text: 'Real bank data with an NBFC partner', capability: 'real_bank_data' },
];

export type StatusChecklistProps = {
  /** Checkable facts; the caller decides which build claim the status read allows. */
  proofItems: ProofBarProps['items'];
  /** The `book` feature flag: link the loan book only when it is on. */
  showBook: boolean;
};

/** 06: what is built and what isn't, then the facts a reader can check for themselves. */
export function StatusChecklist({ proofItems, showBook }: StatusChecklistProps) {
  return (
    <SectionBand labelledBy="status-h" tinted>
      <SectionHeading
        id="status-h"
        kicker="06 · Where we are"
        title="Pre-pilot. The hard part is already live on devnet."
      />
      <ul className="m-0 flex list-none flex-col border-t-3 border-double border-rule-strong p-0">
        {ITEMS.map((item) => (
          <li
            key={item.text}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border py-3 text-lg"
          >
            <span>{item.text}</span>
            <RoadmapBadge capability={item.capability} />
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-3">
        <h3 className="font-mono text-sm tracking-(--tracking-caps) text-muted-foreground uppercase">
          Check it yourself
        </h3>
        <ProofBar items={proofItems} />
        {showBook && (
          <Button asChild size="lg" variant="outline" className="self-start">
            <Link to="/book" search={{ pool: 0 }}>
              See the loan book<span aria-hidden="true">&nbsp;→</span>
            </Link>
          </Button>
        )}
      </div>
    </SectionBand>
  );
}
