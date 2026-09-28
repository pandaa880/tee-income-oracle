/**
 * Deterministic randomness for the generator. Every nonce, id and persona
 * value comes from a labelled SHA-256 seed, so `gen:vectors` is a pure
 * function of the committed keys and CI can regenerate byte for byte.
 * Test data only: nothing here is suitable for real keys.
 */

import { createHash } from 'node:crypto';

import { toHex, utf8 } from '../crypto/encoding.ts';

/** sha256(`tio-vectors/v1/<caseId>/<label>`). */
export function seedBytes(caseId: string, label: string): Uint8Array {
  return sha256(utf8(`tio-vectors/v1/${caseId}/${label}`));
}

/** UUIDv4 (lowercase, hyphenated) from the first 16 seed bytes. */
export function uuidFromSeed(seed: Uint8Array): string {
  const b = Uint8Array.from(seed.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface Prng {
  nextU32(): number;
  int(minIncl: number, maxIncl: number): number;
}

/** Stream of sha256(seed ‖ u32be(counter)) blocks, read 4 bytes at a time. */
export function createPrng(seed: Uint8Array): Prng {
  let counter = 0;
  let block: Uint8Array = new Uint8Array(0);
  let offset = 0;
  const nextU32 = (): number => {
    if (offset + 4 > block.length) {
      const c = new Uint8Array(4);
      new DataView(c.buffer).setUint32(0, counter++);
      block = sha256(Buffer.concat([seed, c]));
      offset = 0;
    }
    const v = new DataView(block.buffer, block.byteOffset).getUint32(offset);
    offset += 4;
    return v;
  };
  return {
    nextU32,
    // Modulo bias is irrelevant for test data.
    int: (minIncl, maxIncl) => minIncl + (nextU32() % (maxIncl - minIncl + 1)),
  };
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}
