import { OpsError } from './errors.ts';
import type { ChainClients } from './send.ts';

export type Cluster = 'localnet' | 'devnet';

const CLUSTERS: readonly Cluster[] = ['localnet', 'devnet'];

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const TESTNET_GENESIS_HASH = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';

/** Public clusters a `localnet` run must never touch. */
const PUBLIC_GENESIS_HASHES: readonly string[] = [
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  TESTNET_GENESIS_HASH,
];

export type ClusterCheck =
  | { ok: true }
  | { ok: false; error: { code: 'cluster_mismatch'; message: string } };

/**
 * Check that the RPC really serves the cluster we were told to set up.
 *
 * The deployments file is named after the cluster, so writing localnet
 * addresses while the RPC points at devnet (or the reverse) would mislead
 * every later step that reads it.
 */
export function checkCluster(cluster: Cluster, genesisHash: string): ClusterCheck {
  const matches =
    cluster === 'devnet'
      ? genesisHash === DEVNET_GENESIS_HASH
      : !PUBLIC_GENESIS_HASHES.includes(genesisHash);
  if (matches) return { ok: true };
  return {
    ok: false,
    error: {
      code: 'cluster_mismatch',
      message: `RPC genesis hash ${genesisHash} is not a ${cluster} cluster`,
    },
  };
}

/**
 * Parse the `--cluster` argument.
 *
 * @throws Error naming the allowed values.
 */
export function parseCluster(arg: string | undefined): Cluster {
  const cluster = CLUSTERS.find((c) => c === arg);
  if (cluster === undefined) {
    throw new Error(`--cluster must be one of ${CLUSTERS.join(', ')}, got ${String(arg)}`);
  }
  return cluster;
}

/** Throws `cluster_mismatch` unless the RPC serves `cluster`; call before reading or sending. */
export async function assertCluster(input: ChainClients & { cluster: Cluster }): Promise<void> {
  const check = checkCluster(input.cluster, await input.rpc.getGenesisHash().send());
  if (!check.ok) throw new OpsError(check.error.code, check.error.message);
}
