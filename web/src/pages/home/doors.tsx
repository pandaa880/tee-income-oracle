import { Link } from '@tanstack/react-router';
import { Badge } from '@tio/ui/badge';
import { Button } from '@tio/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@tio/ui/card';
import { FlowStrip } from '@tio/ui/flow-strip';
import type { Features } from '../../app/config.ts';

export type DoorsProps = { features: Features };

/** Money flows left to right; the demo pool plays the two middle roles at once. */
const ROLES = [
  { label: 'LPs', note: 'supply the money' },
  {
    label: 'Credit vehicle',
    note: 'on-chain reader; funds the NBFC, checks every loan’s attestation',
  },
  { label: 'NBFC', note: 'regulated lender; originates, disburses INR, holds the loans' },
  { label: 'Borrower', note: 'data subject; consents, gets the loan' },
];

const BRACKET = { from: 1, to: 2, label: 'DEMO POOL = NBFC + CREDIT VEHICLE IN ONE PROGRAM' };

/** Two doors: the borrower flow (live) and the lender view (the loan book, with 5c). */
export function Doors({ features }: DoorsProps) {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <section>
        <Card className="h-full">
          <CardHeader rule="double">
            <h2 className="font-display text-xl leading-tight">Try the borrower flow</h2>
            <CardDescription>
              Prove it blind. Show lenders a tier, not your statement.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Pick a test account, approve the consent and watch a tier land on Solana. Then borrow
              against it.
            </p>
            <Button asChild>
              <Link to="/borrow">Borrow</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
      <section>
        <Card className="h-full">
          <CardHeader rule="double">
            <h2 className="font-display text-xl leading-tight">
              Built for NBFCs and the credit vehicles that fund them
            </h2>
            <CardDescription>
              An NBFC shows its book without exposing statements; the vehicle funding it checks
              every loan’s attestation, policy and freshness. The borrower is the data subject, not
              the customer.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
              Who funds whom · money flows left to right
            </p>
            <FlowStrip items={ROLES} bracket={BRACKET} />
            {features.book ? (
              <Button asChild variant="outline">
                <a href="/book">See the loan book</a>
              </Button>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline" tone="accent">
                  NEXT
                </Badge>
                The loan book: every loan with its attestation, policy and freshness.
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
