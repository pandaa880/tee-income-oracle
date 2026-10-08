/**
 * The demo pool's `approved_measurements` bitmap (FORMATS §14): bit `id` is
 * byte `id / 8`, bit `id % 8` from the least significant. Ids run 0..254
 * (255 is never assigned, §13).
 */

const BITMAP_LEN = 32;
const MAX_ID = 254;

function locate(bitmap: Uint8Array, id: number): { byte: number; mask: number } {
  if (bitmap.length !== BITMAP_LEN) {
    throw new Error(`bitmap must be ${BITMAP_LEN} bytes, got ${bitmap.length}`);
  }
  if (!Number.isInteger(id) || id < 0 || id > MAX_ID) {
    throw new Error(`measurement id must be an integer 0..${MAX_ID}, got ${id}`);
  }
  return { byte: Math.floor(id / 8), mask: 1 << (id % 8) };
}

export function hasMeasurementBit(bitmap: Uint8Array, id: number): boolean {
  const { byte, mask } = locate(bitmap, id);
  return ((bitmap[byte] ?? 0) & mask) !== 0;
}

/** A copy of `bitmap` with bit `id` set. */
export function setMeasurementBit(bitmap: Uint8Array, id: number): Uint8Array<ArrayBuffer> {
  const { byte, mask } = locate(bitmap, id);
  const out = Uint8Array.from(bitmap);
  out[byte] = (out[byte] ?? 0) | mask;
  return out;
}

/** A copy of `bitmap` with bit `id` cleared. */
export function clearMeasurementBit(bitmap: Uint8Array, id: number): Uint8Array<ArrayBuffer> {
  const { byte, mask } = locate(bitmap, id);
  const out = Uint8Array.from(bitmap);
  out[byte] = (out[byte] ?? 0) & ~mask;
  return out;
}
