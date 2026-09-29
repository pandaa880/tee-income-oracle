import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { utf8 } from '../crypto/encoding.ts';
import { createPrng, seedBytes, uuidFromSeed } from './prng.ts';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('seedBytes', () => {
  it('is deterministic for the same case id and label', () => {
    expect(seedBytes('case-a', 'nonce')).toEqual(seedBytes('case-a', 'nonce'));
  });

  it('differs for a different case id or label', () => {
    expect(seedBytes('case-a', 'nonce')).not.toEqual(seedBytes('case-b', 'nonce'));
    expect(seedBytes('case-a', 'nonce')).not.toEqual(seedBytes('case-a', 'other'));
  });

  it('equals sha256 of the documented domain string', () => {
    const expected = createHash('sha256').update(utf8('tio-vectors/v1/case-a/nonce')).digest();
    expect(seedBytes('case-a', 'nonce')).toEqual(new Uint8Array(expected));
  });
});

describe('uuidFromSeed', () => {
  it('produces a lowercase hyphenated UUIDv4', () => {
    const uuid = uuidFromSeed(seedBytes('case-a', 'uuid'));
    expect(uuid).toMatch(UUID_V4_RE);
  });

  it('is deterministic for the same seed', () => {
    const seed = seedBytes('case-a', 'uuid');
    expect(uuidFromSeed(seed)).toBe(uuidFromSeed(seed));
  });

  it('differs for a different seed', () => {
    expect(uuidFromSeed(seedBytes('case-a', 'uuid-1'))).not.toBe(
      uuidFromSeed(seedBytes('case-a', 'uuid-2')),
    );
  });
});

describe('createPrng', () => {
  it('is deterministic: the same seed reproduces the same nextU32 sequence', () => {
    const seed = seedBytes('case-a', 'prng');
    const a = createPrng(seed);
    const b = createPrng(seed);
    const sequenceA = Array.from({ length: 10 }, () => a.nextU32());
    const sequenceB = Array.from({ length: 10 }, () => b.nextU32());
    expect(sequenceA).toEqual(sequenceB);
  });

  it('produces nextU32 values that are non-negative 32-bit integers', () => {
    const prng = createPrng(seedBytes('case-a', 'prng-bounds'));
    for (let i = 0; i < 50; i += 1) {
      const value = prng.nextU32();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('int(min, max) always stays within the inclusive bounds', () => {
    const prng = createPrng(seedBytes('case-a', 'int-bounds'));
    for (let i = 0; i < 200; i += 1) {
      const value = prng.int(5, 9);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(9);
    }
  });

  it('int(min, min) always returns min', () => {
    const prng = createPrng(seedBytes('case-a', 'int-degenerate'));
    for (let i = 0; i < 10; i += 1) {
      expect(prng.int(7, 7)).toBe(7);
    }
  });
});
