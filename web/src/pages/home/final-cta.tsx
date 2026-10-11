import { GITHUB_URL } from '../../app/release.ts';
import { ExternalLink } from '../layout/external-link.tsx';
import { DemoCta } from './demo-cta.tsx';

export type FinalCtaProps = { ctaDisabledReason: string | null };

export function FinalCta({ ctaDisabledReason }: FinalCtaProps) {
  return (
    <section className="flex flex-col gap-6 border-t-3 border-double border-rule-strong pt-10">
      <h2 className="font-display text-2xl leading-tight">See it run, end to end</h2>
      <p className="max-w-prose text-muted-foreground">
        Pick a test account, approve the consent and watch a tier land on Solana. Then borrow
        against it.
      </p>
      <div className="flex flex-col items-start gap-2">
        <DemoCta disabledReason={ctaDisabledReason} />
        <p className="text-sm text-muted-foreground">
          Devnet only · demo wallet, nothing to install · no transactions or balances on chain, only
          a tier and its proof fields
        </p>
      </div>
      <p className="max-w-prose text-sm">
        Lending to NBFCs or running a private-credit vehicle? We’re looking for design partners.{' '}
        <ExternalLink href={GITHUB_URL}>Get in touch</ExternalLink>
      </p>
    </section>
  );
}
