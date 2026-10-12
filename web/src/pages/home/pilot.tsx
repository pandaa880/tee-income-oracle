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

/** The business ask (what a pilot tests), with the demo kept one click away. */
export function Pilot({ ctaDisabledReason }: PilotProps) {
  return (
    <section
      id="pilot"
      className="grid scroll-mt-6 grid-cols-1 gap-10 border-t-3 border-double border-rule-strong pt-10 md:grid-cols-[3fr_2fr] md:items-start"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <h2 className="font-display text-3xl leading-tight">Explore a pilot</h2>
        <p className="max-w-prose text-lg text-muted-foreground">
          Lending to NBFCs or running a private-credit vehicle? A pilot tests three things:
        </p>
        <ol className="m-0 flex max-w-prose list-none flex-col border-t border-rule-strong p-0">
          {TESTS.map((test, i) => (
            <li key={test} className="flex gap-4 border-b border-border py-3">
              <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span>{test}</span>
            </li>
          ))}
        </ol>
        <div>
          <Button asChild size="lg">
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
    </section>
  );
}
