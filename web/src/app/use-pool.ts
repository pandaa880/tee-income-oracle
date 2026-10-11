// One pool as the loan page sees it: its parameters, what its vault holds, and this wallet's loan.
import type { Address } from '@solana/kit';
import { useQuery } from '@tanstack/react-query';
import { findLoanPda, findVaultPda, type Loan, type Pool } from '@tio/demo-pool-client';
import { type Deps, realDeps } from './deps.ts';
import { queryKeys } from './query-keys.ts';
import { withDeadline } from './use-credential.ts';
import { toAppError } from '../domain/errors.ts';
import type { AppError } from '../domain/types.ts';

/** `loanAddress` is this wallet's Loan PDA in the pool, whether or not a loan is open. */
export type PoolRead = { pool: Pool; vault: bigint; loan: Loan | null; loanAddress: Address };

export async function fetchPool(
  deps: Deps,
  pool: Address,
  wallet: Address,
  signal: AbortSignal,
): Promise<PoolRead> {
  const [[vault], [loanAddress]] = await Promise.all([
    findVaultPda({ pool }),
    findLoanPda({ pool, borrower: wallet }),
  ]);
  const read = await deps.chain.accounts([pool, vault, loanAddress], signal);
  if (!read.ok) throw read.error;
  const [poolAccount, vaultAccount, loanAccount] = read.value;
  // The pool and its vault always exist once the pool is set up; anything else is a bad read.
  if (poolAccount?.kind !== 'pool' || vaultAccount?.kind !== 'token') {
    throw { code: 'protocol_error' } satisfies AppError;
  }
  return {
    pool: poolAccount.pool,
    vault: vaultAccount.token.amount,
    loan: loanAccount?.kind === 'loan' ? loanAccount.loan : null,
    loanAddress,
  };
}

export function usePool(pool: Address, wallet: Address, deps: Deps = realDeps()) {
  return useQuery<PoolRead, AppError>({
    queryKey: queryKeys.pool(deps.config.cluster, pool, wallet),
    queryFn: ({ signal }) =>
      fetchPool(deps, pool, wallet, withDeadline(signal)).catch((thrown: unknown) => {
        throw toAppError(thrown);
      }),
    staleTime: 5_000,
  });
}
