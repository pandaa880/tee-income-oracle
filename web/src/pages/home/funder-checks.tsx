import { Card } from '@tio/ui/card';
import { StatusBadge } from '@tio/ui/status-badge';
import { FUNDER_CHECKS, checkStatusLabel, checkStatusTone } from '../../domain/funder-checks.ts';

/**
 * The buyer's view: what a funder can check on each loan today, and what isn't there yet. Heading
 * left, the two paragraphs right, then one card per check (board 1d).
 */
export function FunderChecks() {
  return (
    <section className="flex flex-col gap-7">
      <div className="grid grid-cols-1 gap-x-12 gap-y-4 border-b-3 border-double border-rule-strong pb-6 md:grid-cols-2 md:items-start">
        <h2 className="font-display text-2xl leading-tight">
          What a funder can check on every loan
        </h2>
        <div className="flex min-w-0 flex-col gap-3">
          <p className="text-lg text-muted-foreground">
            Today a funder sees an NBFC’s loan tape: loan IDs and scores the NBFC reported itself.
            Here each loan carries its own evidence, and anyone can check it without seeing the
            data.
          </p>
          <p className="text-sm text-muted-foreground">
            A tier says the borrower passed the pool’s eligibility criteria on real bank data. It
            isn’t a score: the NBFC’s own bureau checks and models still pick and price each loan.
            Whether the criteria predict repayment is the funder’s call; outcomes per tier come
            next.
          </p>
        </div>
      </div>
      <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {FUNDER_CHECKS.map((check) => (
          <li key={check.claim} className="min-w-0">
            <Card className="flex h-full flex-col items-start gap-2.5 p-5">
              <StatusBadge
                tone={checkStatusTone(check.status)}
                label={checkStatusLabel(check.status)}
              />
              <strong className="font-semibold">{check.claim}</strong>
              <span className="text-sm text-muted-foreground">{check.evidence}</span>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
