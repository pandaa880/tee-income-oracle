// Pool-side rules for the loan page: how much can be borrowed and how a pool tab reads.
import type { CredentialRecord, CredentialStatus } from './credential.ts';
import { formatTokens } from './format.ts';
import type { Tier } from './types.ts';

/** The pool lends up to the tier limit, but never more than its vault holds. */
export function borrowCeiling(limit: bigint, vault: bigint): bigint {
  return limit < vault ? limit : vault;
}

/** "Pool 0 · up to 5,000", "Pool 1 · not for tier C", "Pool 0 · no tier". */
export function poolLabel(
  poolId: number,
  status: CredentialStatus,
  limit: bigint,
  tier: Tier | null,
): string {
  if (status === 'none') return `Pool ${poolId} · no tier`;
  if (status === 'tier_not_accepted') {
    return `Pool ${poolId} · not for ${tier === null ? 'your tier' : `tier ${tier}`}`;
  }
  return `Pool ${poolId} · up to ${formatTokens(limit)}`;
}

/** The pools that would lend to this wallet right now, with their limit for its tier. */
export function acceptedPools(
  pools: readonly { poolId: number; record: CredentialRecord }[],
): { poolId: number; limit: bigint }[] {
  return pools
    .filter(({ record }) => record.status === 'valid' && record.limit > 0n)
    .map(({ poolId, record }) => ({ poolId, limit: record.limit }));
}
