import { Button } from '@tio/ui/button';
import { DemoCta } from './demo-cta.tsx';
import { ExampleReceipt } from './example-receipt.tsx';

export type HeroProps = {
  /** When the service is down, the CTA is a disabled button and this is the reason shown. */
  ctaDisabledReason: string | null;
};

/** The thesis: a loan decision travels with its receipts, never with the statement. */
export function Hero({ ctaDisabledReason }: HeroProps) {
  return (
    <section className="grid grid-cols-1 items-center gap-10 md:grid-cols-[3fr_2fr]">
      <div className="flex min-w-0 flex-col gap-5">
        <p className="font-mono text-xs tracking-(--tracking-caps) text-tone-positive uppercase">
          Verification oracle for on-chain private credit
        </p>
        <h1 className="font-display text-3xl leading-tight text-balance md:text-4xl">
          Every loan decision, with receipts. No bank statement attached.
        </h1>
        <p className="max-w-prose text-lg text-muted-foreground">
          India’s Account Aggregator proves where a borrower’s data came from. We prove what was
          computed from it. The funder sets the pool’s eligibility criteria; each loan is checked
          against them inside an attested enclave and leaves one tier on Solana, stamped with the
          criteria and the code that produced it.
        </p>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex flex-col items-start gap-2">
            <DemoCta disabledReason={ctaDisabledReason} />
          </div>
          <Button asChild size="lg" variant="outline">
            <a href="#pilot">Explore a pilot</a>
          </Button>
        </div>
        <div className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
          <p>
            Only the enclave, in AWS Mumbai, decrypts the statement. The gateway, the lender, its
            funder and we never see it.
          </p>
          <p>Devnet · simulated bank, real protocol · nothing to install</p>
        </div>
        <p className="max-w-prose border-l-3 border-double border-rule-strong pl-4 font-display text-lg italic">
          The verification oracle that lets on-chain credit vehicles fund real Indian borrowers
          through regulated NBFCs.
        </p>
      </div>
      <div className="flex min-w-0 justify-center md:justify-end">
        <ExampleReceipt />
      </div>
    </section>
  );
}
