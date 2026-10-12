import { Button } from '@tio/ui/button';
import { Card, CardContent } from '@tio/ui/card';
import { PILOT_REQUEST_URL } from '../../app/release.ts';
import { DemoCta } from './demo-cta.tsx';

export type PilotProps = { ctaDisabledReason: string | null };

const TESTS = [
  'Your pool’s eligibility criteria, hash-committed and run blind on consented AA data: in the sandbox first, then on a live AA with your originator as the FIU.',
  'Checking every loan’s receipt yourself (tier, criteria, freshness), with no statements exchanged.',
  'Which trust-based checks on a loan tape (sampling, re-underwriting) per-loan receipts can replace.',
];

/**
 * The business ask (what a pilot tests), with the demo kept one click away. The page's main call
 * to action, so it is an inverted full-width band (board 1d): ink ground and paper text in the
 * light theme, the reverse in dark. All text is the foreground/background pair, so contrast holds
 * in both (no dimmed text: §3 dims with tokens, and there is no inverse-muted one); only the
 * decorative rules use alpha. The demo card keeps its own colours.
 */
export function Pilot({ ctaDisabledReason }: PilotProps) {
  return (
    <section id="pilot" className="scroll-mt-6 bg-foreground text-background">
      <div className="mx-auto grid max-w-(--content-max) grid-cols-1 gap-10 px-4 py-16 md:grid-cols-[3fr_2fr] md:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <p className="font-mono text-xs tracking-(--tracking-caps) uppercase">
            For funders and NBFCs
          </p>
          <h2 className="font-display text-2xl leading-tight md:text-[2.75rem]">Explore a pilot</h2>
          <p className="max-w-prose text-lg">
            Lending to NBFCs or running a private-credit vehicle? A pilot tests three things:
          </p>
          <ol className="m-0 flex max-w-prose list-none flex-col border-t border-background/60 p-0">
            {TESTS.map((test, i) => (
              <li key={test} className="flex gap-4 border-b border-background/25 py-3">
                <span aria-hidden="true" className="font-mono text-xs">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span>{test}</span>
              </li>
            ))}
          </ol>
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
            <p className="text-sm text-muted-foreground">
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
