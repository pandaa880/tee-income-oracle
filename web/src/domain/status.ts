// Is the demo usable right now? Folded from /v1/info, the registry entry and /health.
import type { EnclaveEntry } from '@tio/oracle-client';
import type { Info, Result } from './types.ts';

export type ServiceState = 'live' | 'degraded' | 'down';

export type ServiceStatus = { state: ServiceState; reason: string | null };

const hex = (bytes: ArrayLike<number>): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function serviceStatus(
  info: Result<Info>,
  entry: Result<EnclaveEntry | null>,
  health: Result<true>,
): ServiceStatus {
  if (!info.ok) return { state: 'down', reason: 'gateway_unreachable' };
  // An unreadable registry is the RPC's problem, not proof the enclave is gone.
  if (!entry.ok) return { state: 'degraded', reason: 'registry_unreadable' };
  if (entry.value === null) return { state: 'down', reason: 'enclave_not_registered' };
  if (entry.value.revokedAt !== 0n) return { state: 'down', reason: 'enclave_revoked' };
  const onChain = `0x${hex(entry.value.attester)}`;
  if (onChain.toLowerCase() !== info.value.attesterAddress.toLowerCase()) {
    return { state: 'down', reason: 'attester_mismatch' };
  }
  if (!health.ok) return { state: 'degraded', reason: 'health_check_failed' };
  return { state: 'live', reason: null };
}
