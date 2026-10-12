/**
 * Budget for the one relayer cost a borrower can repeat: the rent of their
 * associated token account. `CreateAssociatedTokenIdempotent` is free when the
 * account exists, but a borrower can close the account after repaying (the rent
 * goes to them) and borrow again, making the relayer pay the rent every cycle.
 * So the relayer funds a wallet's token account at most once per process, and at
 * most `burst` accounts per hour in all. The Loan rent needs no budget: `repay`
 * returns it to the relayer.
 */
import type { Address } from '@solana/kit';

export type SponsorshipBudget = {
  /** True when funding this wallet's token account now stays within the budget. */
  available: (borrower: Address) => boolean;
  /** Records a funded token account; call only after the transaction was sent. */
  spend: (borrower: Address) => void;
};

export const ATA_SPONSOR_BURST = 20;
export const ATA_SPONSOR_PER_HOUR = 20;
const MAX_REMEMBERED_WALLETS = 10_000;

export function createSponsorshipBudget(opts: {
  now: () => number;
  burst?: number;
  perHour?: number;
}): SponsorshipBudget {
  const { now, burst = ATA_SPONSOR_BURST, perHour = ATA_SPONSOR_PER_HOUR } = opts;
  const funded = new Set<Address>();
  let tokens = burst;
  let at = now();

  const refill = (): void => {
    const t = now();
    // Clamped: a wall-clock step backwards must not take tokens away.
    tokens = Math.min(burst, tokens + (Math.max(0, t - at) * perHour) / 3_600_000);
    at = t;
  };

  return {
    available: (borrower) => {
      refill();
      return !funded.has(borrower) && tokens >= 1;
    },
    spend: (borrower) => {
      refill();
      tokens = Math.max(0, tokens - 1);
      // Bounded set: when full, forget every wallet (the hourly bucket still caps the spend).
      if (funded.size >= MAX_REMEMBERED_WALLETS) funded.clear();
      funded.add(borrower);
    },
  };
}
