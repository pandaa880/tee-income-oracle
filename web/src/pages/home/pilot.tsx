import { Button } from '@tio/ui/button';
import { Card, CardContent } from '@tio/ui/card';
import { PILOT_REQUEST_URL } from '../../app/release.ts';
import { DemoCta } from './demo-cta.tsx';

export type PilotProps = { ctaDisabledReason: string | null };

/**
 * The close: the hero's promise restated as the pains it removes, the pilot ask, and the demo one
 * click away. An inverted full-width band: ink ground and paper text in the light theme, the
 * reverse in dark. All text is the foreground/background pair, so contrast holds in both (no
 * dimmed text: §3 dims with tokens, and there is no inverse-muted one); only the decorative rule
 * uses alpha. The demo card keeps its own colours.
 */
export function Pilot({ ctaDisabledReason }: PilotProps) {
  return (
    <section
      id="pilot"
      aria-labelledby="close-h"
      className="scroll-mt-6 bg-foreground text-background"
    >
      <div className="mx-auto grid max-w-(--content-max) grid-cols-1 gap-10 px-4 py-16 md:grid-cols-[3fr_2fr] md:items-end md:py-20">
        <div className="flex min-w-0 flex-col gap-5">
          <p className="font-mono text-sm tracking-(--tracking-caps) uppercase">
            For funders and NBFCs
          </p>
          <h2
            id="close-h"
            className="font-display text-2xl leading-tight text-balance md:text-[2.75rem]"
          >
            Fund the loans, not the spreadsheet.
          </h2>
          <p className="max-w-prose text-xl">
            A pilot shows it on your pool: no sampling, no trusting the tape, each loan checked
            against the borrower’s bank.
          </p>
          <p className="max-w-prose border-t border-background/60 pt-4 text-lg">
            Start with one pool: one NBFC, your criteria, sandbox first.
          </p>
          <div className="pt-2">
            <Button
              asChild
              size="lg"
              className="bg-background text-foreground hover:bg-background/90 focus-visible:outline-background"
            >
              <a href={PILOT_REQUEST_URL} target="_blank" rel="noopener noreferrer">
                Request a pilot<span aria-hidden="true">&nbsp;↗</span>
              </a>
            </Button>
          </div>
        </div>
        <Card className="min-w-0">
          <CardContent className="flex flex-col items-start gap-3">
            <h3 className="font-display text-xl leading-tight">Or see it run first</h3>
            <p className="text-muted-foreground">
              Pick a test account, approve the consent and watch its receipt land on Solana. Then
              borrow against it.
            </p>
            <DemoCta disabledReason={ctaDisabledReason} />
            <p className="font-mono text-xs text-muted-foreground">
              Devnet only · demo wallet, nothing to install · no transactions or balances on chain,
              only a tier and its proof fields
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
