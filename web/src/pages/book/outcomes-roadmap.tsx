import { Badge } from '@tio/ui/badge';

/** What the book can't show yet: the pool has no due dates or defaults (product loop L2). */
export function OutcomesRoadmap() {
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-dashed border-muted-foreground px-5 py-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[1.375rem] leading-tight font-medium">
          Outcomes per tier
        </h2>
        <p className="text-sm text-muted-foreground">
          Coming with due dates and defaults: repaid vs defaulted per tier, the data a lender uses
          to recalibrate its policy.
        </p>
      </div>
      <Badge variant="outline" className="border-dashed border-muted-foreground">
        ROADMAP
      </Badge>
    </section>
  );
}
