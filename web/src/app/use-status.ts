// Live / degraded / down for the status strip: the gateway's word, checked against the registry.
import { useQuery } from '@tanstack/react-query';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { type Deps, realDeps } from './deps.ts';
import { queryKeys } from './query-keys.ts';
import { type ServiceStatus, serviceStatus } from '../domain/status.ts';
import type { Result } from '../domain/types.ts';
import type { EnclaveEntry } from '@tio/oracle-client';

export async function fetchStatus(deps: Deps, signal: AbortSignal): Promise<ServiceStatus> {
  const [info, health] = await Promise.all([
    deps.gateway.info(signal),
    deps.gateway.health(signal),
  ]);
  if (!info.ok) return serviceStatus(info, { ok: true, value: null }, health);
  const [entryAddress] = await findEnclaveEntryPda({ measurementId: info.value.measurementId });
  const read = await deps.chain.accounts([entryAddress], signal);
  const entry: Result<EnclaveEntry | null> = read.ok
    ? {
        ok: true,
        value: read.value[0]?.kind === 'enclave_entry' ? read.value[0].entry : null,
      }
    : read;
  return serviceStatus(info, entry, health);
}

export function useStatus(deps: Deps = realDeps()) {
  return useQuery({
    queryKey: queryKeys.status(deps.config.cluster),
    queryFn: ({ signal }) => fetchStatus(deps, signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
