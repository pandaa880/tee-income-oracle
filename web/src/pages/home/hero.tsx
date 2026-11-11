import { Badge } from '@tio/ui/badge';
import { Button } from '@tio/ui/button';
import { DemoCta } from './demo-cta.tsx';
import { PoolCard } from './pool-card.tsx';

export type HeroProps = {
  /** When the service is down, the CTA is a disabled button and this is the reason shown. */
  ctaDisabledReason: string | null;
  /** The status read says live. "Live" and the positive tone follow it, like every verified marker. */
  live: boolean;
};

/**
 * The category line: proof-of-reserves, applied to a lender's loan book. A full-width sheet
 * band; the simulated pool card sits in the right two-fifths.
 */
export function Hero({ ctaDisabledReason, live }: HeroProps) {
  return (
    <section aria-label="Introduction" className="border-b border-border bg-card">
      <div className="mx-auto grid max-w-(--content-max) grid-cols-1 items-center gap-10 px-4 py-14 md:py-20 lg:grid-cols-[3fr_2fr]">
        <div className="flex min-w-0 flex-col gap-6">
          {/* Loading, degraded or down: a neutral, factual "On Solana devnet". */}
          <Badge variant="outline" tone={live ? 'positive' : 'neutral'} className="self-start">
            {live ? 'Live on Solana devnet' : 'On Solana devnet'}
          </Badge>
          <h1 className="font-display text-2xl leading-tight text-balance md:text-3xl">
            Proof-of-reserves for loan books.
          </h1>
          <p className="max-w-prose text-lg text-muted-foreground">
            Each loan is checked against the borrower’s own bank account, with consent, and carries
            a receipt the funder can check itself. No spreadsheet to take on trust.
          </p>
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex flex-col items-start gap-2">
              <DemoCta disabledReason={ctaDisabledReason} />
            </div>
            <Button asChild size="lg" variant="outline">
              <a href="#solution">See how a pool is checked</a>
            </Button>
          </div>
          <p className="font-mono text-sm text-muted-foreground">
            Devnet demo · sandbox bank · nothing to install
          </p>
        </div>
        <div className="flex min-w-0 justify-center">
          <PoolCard />
        </div>
      </div>
    </section>
  );
}
