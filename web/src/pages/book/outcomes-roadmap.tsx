import { Badge } from '@tio/ui/badge';
import { Card, CardContent, CardHeader } from '@tio/ui/card';

/** What the book can't show yet: the pool has no due dates or defaults (product loop L2). */
export function OutcomesRoadmap() {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-display text-xl leading-tight">Outcomes per tier</h2>
          <Badge variant="outline" tone="accent">
            ROADMAP
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p className="max-w-prose text-sm text-muted-foreground">
          Coming with due dates and defaults: repaid vs defaulted per tier, the data a lender uses
          to recalibrate its policy.
        </p>
      </CardContent>
    </Card>
  );
}
