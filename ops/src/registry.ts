/** Reads the oracle registry (FORMATS §13): the id counter and every entry. */
import {
  type EnclaveEntry,
  fetchAllMaybeEnclaveEntry,
  fetchMaybeConfig,
  findConfigPda,
  findEnclaveEntryPda,
} from '@tio/oracle-client';
import { OpsError } from './errors.ts';
import type { ChainClients } from './send.ts';

/** `getMultipleAccounts` takes at most 100 addresses per call. */
const BATCH = 100;

export type Registry = { nextMeasurementId: number; entries: EnclaveEntry[] };

/**
 * Ids are assigned densely from 0 up to `next_measurement_id` and never
 * reused, so reading `0..next` finds every entry, active or revoked.
 *
 * @throws OpsError `oracle_not_initialized`.
 */
export async function readRegistry({ rpc }: ChainClients): Promise<Registry> {
  const config = await fetchMaybeConfig(rpc, (await findConfigPda())[0]);
  if (!config.exists) throw new OpsError('oracle_not_initialized', 'run oracle:init first');
  const next = config.data.nextMeasurementId;
  const addresses = await Promise.all(
    Array.from(
      { length: next },
      async (_, id) => (await findEnclaveEntryPda({ measurementId: id }))[0],
    ),
  );
  const entries: EnclaveEntry[] = [];
  for (let start = 0; start < addresses.length; start += BATCH) {
    const accounts = await fetchAllMaybeEnclaveEntry(rpc, addresses.slice(start, start + BATCH));
    for (const account of accounts) if (account.exists) entries.push(account.data);
  }
  return { nextMeasurementId: next, entries };
}

/** Ids of the entries not revoked. */
export const activeIds = (registry: Registry): number[] =>
  registry.entries.filter((e) => e.revokedAt === 0n).map((e) => e.measurementId);
