import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromHex, pemToDer } from './encoding.ts';
import { KeyError } from './ecdh.ts';
import { SPKI_LEN, encodeSpki, parseSpki, sharedFromU } from './wei25519.ts';

interface EccVector {
  readonly fip: {
    readonly key_material: { readonly DHPublicKey: { readonly KeyValue: string } };
    readonly public_montgomery_u_le_hex: string;
    readonly public_point_uncompressed_hex: string;
  };
  readonly fiu: {
    readonly key_material: { readonly DHPublicKey: { readonly KeyValue: string } };
    readonly public_montgomery_u_le_hex: string;
    readonly public_point_uncompressed_hex: string;
  };
  readonly shared_secret_hex: string;
  readonly shared_secret_montgomery_u_le_hex: string;
}

interface EccGolden {
  readonly vectors: readonly EccVector[];
}

function readGoldenJson(relativePath: string): unknown {
  const url = new URL(`../../../test-vectors/golden/${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const golden = readGoldenJson('rahasya/ecc.json') as EccGolden;

// The last 65 bytes of a 309-byte wei25519 SPKI DER are the uncompressed
// point `04 || X || Y` (FORMATS §3). The 66-byte BIT STRING content is one
// unused-bits byte `00` followed by that point.
const POINT_LEN = 65;

function xCoordinate(der: Uint8Array): Uint8Array {
  const point = der.slice(der.length - POINT_LEN);
  return point.slice(1, 33);
}

describe('golden anchor: rahasya ecc.json', () => {
  it.each(golden.vectors.map((v, i) => [i, v] as const))(
    'vector %i: parseSpki(pemToDer(KeyValue)) matches the golden Montgomery u for both roles',
    (_i, vector) => {
      const fipU = parseSpki(pemToDer(vector.fip.key_material.DHPublicKey.KeyValue));
      expect(fipU).toEqual(fromHex(vector.fip.public_montgomery_u_le_hex));

      const fiuU = parseSpki(pemToDer(vector.fiu.key_material.DHPublicKey.KeyValue));
      expect(fiuU).toEqual(fromHex(vector.fiu.public_montgomery_u_le_hex));
    },
  );

  it.each(golden.vectors.map((v, i) => [i, v] as const))(
    'vector %i: sharedFromU(raw X25519 u) matches the golden wei25519 shared secret',
    (_i, vector) => {
      const u = fromHex(vector.shared_secret_montgomery_u_le_hex);
      expect(sharedFromU(u)).toEqual(fromHex(vector.shared_secret_hex));
    },
  );
});

describe('encodeSpki', () => {
  const vector = golden.vectors[0];
  if (vector === undefined) {
    throw new Error('golden ecc.json must have at least one vector');
  }
  const u = fromHex(vector.fip.public_montgomery_u_le_hex);
  const der = encodeSpki(u);

  it('is 309 bytes', () => {
    expect(der.length).toBe(SPKI_LEN);
    expect(der.length).toBe(309);
  });

  it('base64 starts with the fixed wei25519 prefix', () => {
    expect(Buffer.from(der).toString('base64').startsWith('MIIBMTCB6gYHKoZIzj0CAT')).toBe(true);
  });

  it('round-trips through parseSpki', () => {
    expect(parseSpki(der)).toEqual(u);
  });

  it('encodes the same x-coordinate as the golden BouncyCastle point (y may differ)', () => {
    const goldenPoint = fromHex(vector.fip.public_point_uncompressed_hex);
    const goldenX = goldenPoint.slice(1, 33);
    expect(xCoordinate(der)).toEqual(goldenX);
  });
});

describe('parseSpki rejections', () => {
  const vector = golden.vectors[0];
  if (vector === undefined) {
    throw new Error('golden ecc.json must have at least one vector');
  }
  const validDer = encodeSpki(fromHex(vector.fip.public_montgomery_u_le_hex));

  it('rejects a truncated DER (wrong length) as bad_key_material', () => {
    const truncated = validDer.slice(0, validDer.length - 1);
    expect(() => parseSpki(truncated)).toThrow(KeyError);
    try {
      parseSpki(truncated);
      throw new Error('expected parseSpki to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KeyError);
      expect((e as KeyError).code).toBe('bad_key_material');
    }
  });

  it('rejects a flipped leading prefix byte as bad_key_material', () => {
    const flipped = new Uint8Array(validDer);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    try {
      parseSpki(flipped);
      throw new Error('expected parseSpki to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KeyError);
      expect((e as KeyError).code).toBe('bad_key_material');
    }
  });

  it('rejects an x-coordinate ≥ p as invalid_point', () => {
    const bad = new Uint8Array(validDer);
    // The x-coordinate occupies the 32 bytes right after the leading 0x04
    // of the uncompressed point, at the tail of the DER.
    const xStart = bad.length - POINT_LEN + 1;
    bad.fill(0xff, xStart, xStart + 32);
    try {
      parseSpki(bad);
      throw new Error('expected parseSpki to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KeyError);
      expect((e as KeyError).code).toBe('invalid_point');
    }
  });

  it('rejects an off-curve y-coordinate as invalid_point', () => {
    const bad = new Uint8Array(validDer);
    // The last byte of the DER is the low byte of the y-coordinate;
    // flipping it is astronomically unlikely to land back on the curve.
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0x01;
    try {
      parseSpki(bad);
      throw new Error('expected parseSpki to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KeyError);
      expect((e as KeyError).code).toBe('invalid_point');
    }
  });
});
