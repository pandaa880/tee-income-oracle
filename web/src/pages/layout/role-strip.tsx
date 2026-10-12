import { FlowStrip } from '@tio/ui/flow-strip';

/** Money flows left to right; the demo pool plays the two middle roles at once. */
const ROLES = [
  { kicker: 'Capital', label: 'LPs', note: 'supply the money' },
  {
    kicker: 'On-chain reader',
    label: 'Credit vehicle',
    note: 'sets the criteria, funds the NBFC, checks every loan’s receipt',
  },
  {
    kicker: 'Regulated lender',
    label: 'NBFC',
    note: 'originates, disburses INR, holds the loans',
  },
  { kicker: 'Data subject', label: 'Borrower', note: 'consents; gets the loan' },
];

const BRACKET = { from: 1, to: 2, label: 'DEMO POOL = NBFC + CREDIT VEHICLE IN ONE PROGRAM' };

/** Who funds whom: on the lender door and the loan book. */
export function RoleStrip() {
  return (
    <figure aria-label="Who funds whom" className="m-0 flex flex-col gap-1.5">
      <figcaption className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
        Who funds whom · money flows left to right
      </figcaption>
      <FlowStrip items={ROLES} bracket={BRACKET} />
    </figure>
  );
}
