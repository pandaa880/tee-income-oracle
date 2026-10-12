// "Who signed it": the enclave builds the deployment file lists, each with the state of its
// registry entry on chain. Pure.
import type { EnclaveEntry } from '@tio/oracle-client';
import type { Tone } from '@tio/ui/tokens';
import type { EnclaveRecord } from '@tio/verifier/deployment';
import { toEthHex } from '@tio/verifier/eth-address';

export type BuildStatus = 'active' | 'revoked' | 'unknown';

export type BuildRow = {
  id: number;
  status: BuildStatus;
  /**
   * `0x` + 40 hex. From the chain entry whenever there is one (the key the verifier compares the
   * document against); the deployment file's value only for a build the chain has no entry for.
   */
  attester: string;
  /** Null while the chain has no entry for the build. */
  registeredAt: bigint | null;
  /** Null unless the entry is revoked. */
  revokedAt: bigint | null;
};

const BUILD_TONE: Record<BuildStatus, Tone> = {
  active: 'positive',
  revoked: 'neutral',
  unknown: 'caution',
};

/** The only place a build status becomes a colour role. */
export function buildTone(status: BuildStatus): Tone {
  return BUILD_TONE[status];
}

function rowOf(record: EnclaveRecord, entry: EnclaveEntry | null): BuildRow {
  if (entry === null) {
    return {
      id: record.measurementId,
      status: 'unknown',
      attester: record.attester,
      registeredAt: null,
      revokedAt: null,
    };
  }
  const revoked = entry.revokedAt !== 0n;
  return {
    id: record.measurementId,
    status: revoked ? 'revoked' : 'active',
    attester: toEthHex(new Uint8Array(entry.attester)),
    registeredAt: entry.registeredAt,
    revokedAt: revoked ? entry.revokedAt : null,
  };
}

/** One row per record, `entries[i]` being the chain entry of `enclaves[i]`; newest build first. */
export function buildRows(
  enclaves: readonly EnclaveRecord[],
  entries: readonly (EnclaveEntry | null)[],
): BuildRow[] {
  return enclaves
    .map((record, i) => rowOf(record, entries[i] ?? null))
    .toSorted((a, b) => b.id - a.id);
}
