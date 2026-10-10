import type { Address } from '@solana/kit';

/** `[resource, cluster, address]`: a cluster or wallet change never shares a cache entry. */
export const queryKeys = {
  credential: (cluster: string, wallet: Address) => ['credential', cluster, wallet] as const,
  loan: (cluster: string, pool: Address, wallet: Address) =>
    ['loan', cluster, pool, wallet] as const,
  status: (cluster: string) => ['status', cluster] as const,
};
