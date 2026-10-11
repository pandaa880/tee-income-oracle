import { DemoCta } from './demo-cta.tsx';

export type HeroProps = {
  /** When the service is down, the CTA is a disabled button and this is the reason shown. */
  ctaDisabledReason: string | null;
};

export function Hero({ ctaDisabledReason }: HeroProps) {
  return (
    <section className="flex flex-col gap-6">
      <p className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
        Verification oracle for on-chain private credit
      </p>
      <h1 className="font-display text-3xl leading-tight md:text-4xl">
        Years of real income, no credit file. Prove it without the statement.
      </h1>
      <p className="max-w-prose text-lg text-muted-foreground">
        A hardware enclave runs the lender's policy on AA-signed, bank-originated data and writes
        one tier to Solana. No one, including us, ever sees the statement.
      </p>
      <p className="max-w-prose">
        The verification oracle that lets on-chain credit vehicles fund real Indian borrowers
        through regulated NBFCs.
      </p>
      <div className="flex flex-col items-start gap-2">
        <DemoCta disabledReason={ctaDisabledReason} />
        <p className="text-sm text-muted-foreground">
          Devnet · simulated bank, real protocol · nothing to install
        </p>
      </div>
    </section>
  );
}
