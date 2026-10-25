/**
 * `enclave:rotate` arguments beyond `--cluster`, `--enclave-ip` and `--release`.
 * Parsed before any RPC so a typo fails fast and sends nothing.
 */
import { OpsError } from './errors.ts';

/** Ids 0..254 (FORMATS §13); 255 is never assigned. */
const MEASUREMENT_ID_MAX = 254;
const WHOLE_NUMBER = /^\d+$/;

/**
 * `--keep-active a,b`: registry ids to leave active and approved; default none.
 * Returned sorted and without repeats.
 */
export function parseKeepActive(raw: string | undefined): number[] {
  if (raw === undefined) return [];
  const parts = raw.split(',');
  if (!parts.every((p) => WHOLE_NUMBER.test(p) && Number(p) <= MEASUREMENT_ID_MAX)) {
    throw new OpsError(
      'invalid_keep_active',
      '--keep-active must be comma-separated measurement ids 0..254',
    );
  }
  return [...new Set(parts.map(Number))].toSorted((a, b) => a - b);
}
