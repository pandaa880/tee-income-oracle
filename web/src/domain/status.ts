// Is the demo usable right now? Folded from /v1/info, the registry entry and /health.
import type { EnclaveEntry } from '@tio/oracle-client';
import type { Tone } from '@tio/ui/tokens';
import type { Info, Result } from './types.ts';

export type ServiceState = 'live' | 'degraded' | 'down';

export type StatusReason =
  | 'gateway_unreachable'
  | 'registry_unreadable'
  | 'enclave_not_registered'
  | 'enclave_revoked'
  | 'attester_mismatch'
  | 'health_check_failed';

export type ServiceStatus = {
  state: ServiceState;
  reason: StatusReason | null;
  /** The enclave build the gateway submits with, once `/v1/info` answered. */
  measurementId: number | null;
};

const hex = (bytes: ArrayLike<number>): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function judge(
  info: Info,
  entry: Result<EnclaveEntry | null>,
  health: Result<true>,
): Pick<ServiceStatus, 'state' | 'reason'> {
  // An unreadable registry is the RPC's problem, not proof the enclave is gone.
  if (!entry.ok) return { state: 'degraded', reason: 'registry_unreadable' };
  if (entry.value === null) return { state: 'down', reason: 'enclave_not_registered' };
  if (entry.value.revokedAt !== 0n) return { state: 'down', reason: 'enclave_revoked' };
  const onChain = `0x${hex(entry.value.attester)}`;
  if (onChain.toLowerCase() !== info.attesterAddress.toLowerCase()) {
    return { state: 'down', reason: 'attester_mismatch' };
  }
  if (!health.ok) return { state: 'degraded', reason: 'health_check_failed' };
  return { state: 'live', reason: null };
}

export function serviceStatus(
  info: Result<Info>,
  entry: Result<EnclaveEntry | null>,
  health: Result<true>,
): ServiceStatus {
  if (!info.ok) return { state: 'down', reason: 'gateway_unreachable', measurementId: null };
  return { ...judge(info.value, entry, health), measurementId: info.value.measurementId };
}

const BANNER: Record<StatusReason, string> = {
  gateway_unreachable: 'The demo gateway is not answering. The flow cannot start right now.',
  registry_unreadable:
    'The Solana RPC did not answer when we looked up the enclave registry. The demo may still work.',
  enclave_not_registered:
    'The running enclave has no entry in the on-chain registry, so pools would refuse its tiers.',
  enclave_revoked: 'The running enclave build was retired on chain. New tiers are refused.',
  attester_mismatch:
    'The enclave key differs from the one registered on chain. New tiers would be refused.',
  health_check_failed: 'The gateway health check failed. The flow may be slow or stall.',
};

const STATE_WORD: Record<ServiceState, string> = {
  live: 'LIVE ON DEVNET',
  degraded: 'DEGRADED ON DEVNET',
  down: 'DOWN ON DEVNET',
};

/**
 * The gateway's enclave build, but only when the registry read confirmed it: the entry exists,
 * isn't revoked and holds the gateway's attester. `/v1/info` alone is the gateway's word.
 */
export function registeredBuild(status: ServiceStatus | undefined): number | null {
  if (status === undefined) return null;
  const confirmed = status.state === 'live' || status.reason === 'health_check_failed';
  return confirmed ? status.measurementId : null;
}

export type StatusLabel = { strip: string; banner: string | null; bannerTone: Tone };

/** The mono-caps strip and, when something is wrong, a sentence for a banner. */
export function statusLabel(status: ServiceStatus, pools = 0): StatusLabel {
  const build = registeredBuild(status);
  const parts = [
    STATE_WORD[status.state],
    build === null ? 'ENCLAVE BUILD' : `ENCLAVE BUILD #${build}`,
  ];
  if (status.state === 'live') parts.push('REGISTERED', 'GATEWAY UP');
  if (status.state === 'live' && pools > 0) parts.push(`${pools} POOLS READING THE ORACLE`);
  return {
    strip: parts.join(' · '),
    banner: status.reason === null ? null : BANNER[status.reason],
    bannerTone: status.state === 'down' ? 'negative' : 'caution',
  };
}
