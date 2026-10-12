import { FlowStrip } from '@tio/ui/flow-strip';

/** Money flows left to right; the demo pool plays the two middle roles at once. */
const ROLES = [
  { label: 'LPs', note: 'supply the money' },
  {
    label: 'Credit vehicle',
    note: 'on chain; sets the criteria, funds the NBFC, checks every loan’s receipt',
  },
  { label: 'NBFC', note: 'regulated lender; originates, disburses INR, holds the loans' },
  { label: 'Borrower', note: 'data subject; consents, gets the loan' },
];

const BRACKET = { from: 1, to: 2, label: 'DEMO POOL = NBFC + CREDIT VEHICLE IN ONE PROGRAM' };

/** Who funds whom: on the lender door and the loan book. */
export function RoleStrip() {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
        Who funds whom · money flows left to right
      </p>
      <FlowStrip items={ROLES} bracket={BRACKET} />
    </div>
  );
}
