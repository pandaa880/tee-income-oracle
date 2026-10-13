import type { Address } from '@solana/kit';

/** `[resource, cluster, address]`: a cluster or wallet change never shares a cache entry. */
export const queryKeys = {
  credential: (cluster: string, wallet: Address) => ['credential', cluster, wallet] as const,
  pool: (cluster: string, pool: Address, wallet: Address) =>
    ['pool', cluster, pool, wallet] as const,
  status: (cluster: string) => ['status', cluster] as const,
  book: (cluster: string, pool: Address) => ['book', cluster, pool] as const,
  /** `null` is the idle key of a verification without a wallet (never fetched). */
  verify: (cluster: string, wallet: Address | null) => ['verify', cluster, wallet] as const,
  builds: (cluster: string) => ['builds', cluster] as const,
};
