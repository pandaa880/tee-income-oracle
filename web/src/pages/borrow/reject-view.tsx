import { Button } from '@tio/ui/button';
import { Seal } from '@tio/ui/seal';
import { tierTone } from '../../domain/tier-tone.ts';

export type RejectViewProps = { onReset: () => void };

/** A REJECT stores nothing: no lender can see it, and the statement is gone either way. */
export function RejectView({ onReset }: RejectViewProps) {
  return (
    <section className="flex flex-col items-start gap-6">
      <Seal tone={tierTone('REJECT')} label="NO TIER" />
      <h2 className="font-display text-2xl leading-tight">No tier this time</h2>
      <p className="max-w-prose text-muted-foreground">
        This account doesn't pass the pool's published eligibility criteria.
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        <li>Nothing was written on chain. No lender can see a rejection.</li>
        <li>Your statement was wiped, the same as for a pass.</li>
      </ul>
      <Button onClick={onReset}>Try another account</Button>
    </section>
  );
}
