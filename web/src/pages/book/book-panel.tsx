import type { Address } from '@solana/kit';
import { useNavigate } from '@tanstack/react-router';
import { Skeleton } from '@tio/ui/skeleton';
import { useBook } from '../../app/use-book.ts';
import { useConfig } from '../../app/use-config.ts';
import { ErrorCard } from '../borrow/error-card.tsx';
import { BookKpis } from './book-kpis.tsx';
import { LoanTable } from './loan-table.tsx';
import { OutcomesRoadmap } from './outcomes-roadmap.tsx';
import { PolicyCard } from './policy-card.tsx';
import { TierMix } from './tier-mix.tsx';

export type BookPanelProps = { pool: Address };

function Loading() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/**
 * One pool's book. A failed background refresh keeps the last good book on screen; only a
 * first read that fails shows the error card.
 */
export function BookPanel({ pool }: BookPanelProps) {
  const { cluster } = useConfig();
  const navigate = useNavigate();
  const book = useBook(pool);
  const retry = () => void book.refetch();

  if (book.data === undefined) {
    if (book.error === null) return <Loading />;
    return (
      <ErrorCard
        error={book.error}
        onRestart={retry}
        onRetry={retry}
        onReattest={() => void navigate({ to: '/borrow' })}
        fallback="retry"
      />
    );
  }

  const { policy, kpis, tierMix, rows } = book.data;
  return (
    <div className="flex flex-col gap-6">
      <PolicyCard policy={policy} cluster={cluster} />
      <BookKpis kpis={kpis} />
      <TierMix mix={tierMix} />
      <LoanTable rows={rows} cluster={cluster} />
      <p className="max-w-prose text-sm text-muted-foreground">
        An enclave restart retires its old build, so every credential it issued shows “build
        retired” until the borrower re-attests — monitoring, not a bug. “Old policy” = issued under
        rules this pool no longer accepts; new borrows need a fresh attestation.
      </p>
      <OutcomesRoadmap />
    </div>
  );
}
