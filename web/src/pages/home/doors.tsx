import { Link } from '@tanstack/react-router';
import { Badge } from '@tio/ui/badge';
import { Button } from '@tio/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@tio/ui/card';
import type { Features } from '../../app/config.ts';
import { RoleStrip } from '../layout/role-strip.tsx';

export type DoorsProps = { features: Features };

/** Two doors: the borrower flow (live) and the lender view (the loan book, with 5c). */
export function Doors({ features }: DoorsProps) {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <section>
        <Card className="h-full">
          <CardHeader rule="double">
            <h2 className="font-display text-xl leading-tight">Try the borrower flow</h2>
            <CardDescription>
              Years of real income, no credit file? Show a lender a tier computed from your
              statement, not the statement.
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
              The funder sets the eligibility criteria every loan must pass; the NBFC keeps its own
              underwriting and shows each funded loan’s receipt without sharing statements. The
              borrower is the data subject, not the customer.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <RoleStrip />
            {features.book ? (
              <Button asChild variant="outline">
                <Link to="/book" search={{ pool: 0 }}>
                  See the loan book
                </Link>
              </Button>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline" tone="accent">
                  NEXT
                </Badge>
                The loan book: every loan with its receipt, side by side.
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
