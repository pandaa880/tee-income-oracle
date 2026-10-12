import type { Address } from '@solana/kit';
import { useNavigate } from '@tanstack/react-router';
import { Skeleton } from '@tio/ui/skeleton';
import { useConfig } from '../../app/use-config.ts';
import { useCredential } from '../../app/use-credential.ts';
import { useLoan } from '../../app/use-loan.ts';
import { usePool } from '../../app/use-pool.ts';
import { tierFromByte } from '../../domain/credential.ts';
import { explorerTxUrl } from '../../domain/explorer.ts';
import { formatTokens } from '../../domain/format.ts';
import { ErrorCard } from '../borrow/error-card.tsx';
import { ExternalLink } from '../layout/external-link.tsx';
import { BorrowForm } from './borrow-form.tsx';
import { CredentialCard } from './credential-card.tsx';
import { OpenLoan } from './open-loan.tsx';

export type PoolPanelProps = {
  pool: { address: Address; poolId: number };
  wallet: Address;
};

function Loading() {
  return (
    <div className="flex max-w-xl flex-col gap-3" aria-busy="true">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-6 w-2/3" />
    </div>
  );
}

/** A landed borrow or repay, with its transaction. */
function Receipt({ text, href }: { text: string; href: string }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-2 text-sm">
      {text} <ExternalLink href={href}>Transaction</ExternalLink>
    </p>
  );
}

/**
 * One pool: an open loan (always repayable: repay needs no attestation, so not even a failed
 * credential read hides it), else what the pool says about the wallet's tier: borrow, or the way
 * back to a usable tier. Cached reads stay on screen when a background refetch fails. Receipts
 * live here, in the component that owns the mutations, so they survive the refetch a landed
 * loan triggers.
 */
export function PoolPanel({ pool, wallet }: PoolPanelProps) {
  const { cluster } = useConfig();
  const navigate = useNavigate();
  const credential = useCredential(wallet, pool.address);
  const read = usePool(pool.address, wallet);
  const { borrow, repay } = useLoan(pool.address);
  const reattest = () => void navigate({ to: '/borrow' });
  const refetch = () => void Promise.all([credential.refetch(), read.refetch()]);
  const status = credential.data?.status ?? null;

  if (read.data?.loan) {
    return (
      <div className="flex flex-col gap-6">
        {borrow.data !== undefined && borrow.variables !== undefined && (
          <Receipt
            text={`Borrowed ${formatTokens(borrow.variables)} tokens. They're in your wallet.`}
            href={explorerTxUrl(cluster, borrow.data)}
          />
        )}
        <OpenLoan
          loan={read.data.loan}
          status={status}
          pending={repay.isPending}
          error={repay.error}
          cluster={cluster}
          loanAddress={read.data.loanAddress}
          onRepay={() => repay.mutate(undefined, { onSuccess: () => borrow.reset() })}
          onDismissError={() => repay.reset()}
          onReattest={reattest}
        />
      </div>
    );
  }
  if (credential.data === undefined || read.data === undefined) {
    const failed = credential.error ?? read.error;
    if (failed === null) return <Loading />;
    return (
      <ErrorCard
        error={failed}
        onRestart={refetch}
        onRetry={refetch}
        onReattest={reattest}
        fallback="retry"
      />
    );
  }

  const { record, limit } = credential.data;
  const tier = record === null ? null : tierFromByte(record.payload.tier);
  const usable = credential.data.status === 'valid' && tier !== null;
  return (
    <div className="flex flex-col gap-6">
      {repay.data !== undefined && (
        <Receipt
          text={
            usable
              ? 'Loan repaid. Your tier is still valid: borrow again any time.'
              : 'Loan repaid.'
          }
          href={explorerTxUrl(cluster, repay.data)}
        />
      )}
      {!usable || tier === null ? (
        <CredentialCard status={credential.data.status} />
      ) : (
        <BorrowForm
          tier={tier}
          limit={limit}
          vault={read.data.vault}
          pending={borrow.isPending}
          error={borrow.error}
          onBorrow={(amount) => borrow.mutate(amount, { onSuccess: () => repay.reset() })}
          onDismissError={() => borrow.reset()}
          onReattest={reattest}
        />
      )}
    </div>
  );
}
