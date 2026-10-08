/**
 * What `enclave:rotate` must send, from the chain state it read (pure).
 *
 * An enclave restart gets a new attester key, so it is a new registry entry
 * (FORMATS §13). Every pool must approve the new id (§14), and the old
 * entries are revoked so their attestations stop lending. A re-run after a
 * partial failure finds the entry it already registered and only finishes
 * the rest.
 */
import { clearMeasurementBit, setMeasurementBit } from './bitmap.ts';

/** Ids 0..254; 255 is never assigned (§13). */
const FIRST_UNUSABLE_ID = 255;

export type EntryView = {
  measurementId: number;
  measurement: Uint8Array;
  attester: Uint8Array;
  revokedAt: bigint;
};

export type PoolView = { address: string; approvedMeasurements: Uint8Array };

export type NewEnclave = { imageId: Uint8Array; attester: Uint8Array; docHash: Uint8Array };

export type RotatePlan = {
  measurementId: number;
  register: boolean;
  poolUpdates: PoolView[];
  revoke: number[];
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** @throws Error when a new entry is needed and the registry is full. */
export function planRotate(input: {
  nextMeasurementId: number;
  entries: EntryView[];
  pools: PoolView[];
  enclave: NewEnclave;
}): RotatePlan {
  const active = input.entries.filter((e) => e.revokedAt === 0n);
  const existing = active.find(
    (e) =>
      sameBytes(e.attester, input.enclave.attester) &&
      sameBytes(e.measurement, input.enclave.imageId),
  );
  if (existing === undefined && input.nextMeasurementId >= FIRST_UNUSABLE_ID) {
    throw new Error('registry full: no measurement id left (FORMATS §13 id budget)');
  }
  const measurementId = existing?.measurementId ?? input.nextMeasurementId;
  const revoke = active
    .map((e) => e.measurementId)
    .filter((id) => id !== measurementId)
    .toSorted((a, b) => a - b);
  return {
    measurementId,
    register: existing === undefined,
    poolUpdates: poolUpdates(input.pools, measurementId, revoke),
    revoke,
  };
}

/** Pools whose bitmap changes once `approve` is set and every `revoke` id cleared. */
function poolUpdates(pools: PoolView[], approve: number, revoke: number[]): PoolView[] {
  const updates: PoolView[] = [];
  for (const pool of pools) {
    const next = revoke.reduce(
      (bitmap, id) => clearMeasurementBit(bitmap, id),
      setMeasurementBit(pool.approvedMeasurements, approve),
    );
    if (!sameBytes(next, pool.approvedMeasurements)) {
      updates.push({ address: pool.address, approvedMeasurements: next });
    }
  }
  return updates;
}
