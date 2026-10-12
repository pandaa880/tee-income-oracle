import type { Address } from '@solana/kit';
import { Skeleton } from '@tio/ui/skeleton';
import { useVerification } from '../../app/use-verification.ts';
import { AttestationCard } from './attestation-card.tsx';
import { BuildsAside } from './builds-aside.tsx';
import { ChecksCard } from './checks-card.tsx';
import { VerifyError } from './verify-error.tsx';

export type VerificationResultProps = { wallet: Address };

function Loading() {
  return (
    // `aria-busy` on the region being filled, the live text outside it, or readers hold the announcement.
    <div className="flex flex-col gap-3" aria-busy="true">
      <p role="status" className="text-sm text-muted-foreground">
        Reading the attestation and running the checks…
      </p>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** Everything under the form once there is a wallet: the facts, the builds aside, the checks. */
export function VerificationResult({ wallet }: VerificationResultProps) {
  const query = useVerification(wallet);
  const retry = () => void query.refetch();

  if (query.data === undefined) {
    return (
      <>
        {query.error === null ? <Loading /> : <VerifyError error={query.error} onRetry={retry} />}
        <div className="flex flex-wrap items-start gap-6">
          <BuildsAside />
        </div>
      </>
    );
  }

  return (
    <>
      <AttestationCard view={query.data} />
      <div className="flex flex-wrap items-start gap-6">
        <BuildsAside />
        <ChecksCard view={query.data} wallet={wallet} />
      </div>
    </>
  );
}
