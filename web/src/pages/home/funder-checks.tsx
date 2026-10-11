import { StatusBadge } from '@tio/ui/status-badge';
import { FUNDER_CHECKS, checkStatusLabel, checkStatusTone } from '../../domain/funder-checks.ts';

/** The buyer's view: what a funder can check on each loan today, and what isn't there yet. */
export function FunderChecks() {
  return (
    <section className="flex flex-col gap-5">
      <h2 className="font-display text-2xl leading-tight">What a funder can check on every loan</h2>
      <p className="max-w-prose text-lg text-muted-foreground">
        A statement analyser asks you to trust its score. Here each loan carries its own evidence,
        and anyone can check it without seeing the data.
      </p>
      <ul className="m-0 flex list-none flex-col border-t-3 border-double border-rule-strong p-0">
        {FUNDER_CHECKS.map((check) => (
          <li
            key={check.claim}
            className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-border py-4"
          >
            <strong className="min-w-0 flex-[1_1_22rem] font-semibold">{check.claim}</strong>
            <span className="min-w-0 flex-[1_1_20rem] text-sm text-muted-foreground">
              {check.evidence}
            </span>
            <StatusBadge
              tone={checkStatusTone(check.status)}
              label={checkStatusLabel(check.status)}
            />
          </li>
        ))}
      </ul>
      <p className="max-w-prose text-sm text-muted-foreground">
        A tier says the borrower passed the lender’s rules on real bank data. Whether those rules
        predict repayment is the lender’s call; outcomes per tier come next.
      </p>
    </section>
  );
}
