import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromHex } from './encoding.ts';
import { KeyError, sessionKeyPairFromScalar, spkiMode } from './ecdh.ts';

interface X25519Golden {
  readonly fip: { readonly private_key_raw_hex: string; readonly public_key_spki_hex: string };
  readonly fiu: { readonly private_key_raw_hex: string; readonly public_key_spki_hex: string };
  readonly shared_secret_hex: string;
}

function readGoldenJson(relativePath: string): unknown {
  const url = new URL(`../../../test-vectors/golden/${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const golden = readGoldenJson('rahasya/x25519.json') as X25519Golden;

// Fixed 32-byte scalars, distinct in every byte, used only to exercise the
// wei25519 key-pair round trip (not tied to any golden vector).
const SCALAR_A = new Uint8Array(32).map((_, i) => i + 1);
const SCALAR_B = new Uint8Array(32).map((_, i) => 31 - i);

describe('golden anchor: rahasya x25519.json', () => {
  it('sessionKeyPairFromScalar reproduces the FIP public SPKI', () => {
    const pair = sessionKeyPairFromScalar('x25519', fromHex(golden.fip.private_key_raw_hex));
    expect(pair.mode).toBe('x25519');
    expect(pair.publicSpki).toEqual(fromHex(golden.fip.public_key_spki_hex));
  });

  it('sharedSecret against the FIU SPKI reproduces the golden shared secret', () => {
    const pair = sessionKeyPairFromScalar('x25519', fromHex(golden.fip.private_key_raw_hex));
    const shared = pair.sharedSecret(fromHex(golden.fiu.public_key_spki_hex));
    expect(shared).toEqual(fromHex(golden.shared_secret_hex));
  });
});

describe('wei25519 key pairs', () => {
  it('two pairs from fixed scalars agree on the shared secret in both directions', () => {
    const a = sessionKeyPairFromScalar('wei25519', SCALAR_A);
    const b = sessionKeyPairFromScalar('wei25519', SCALAR_B);

    const sharedByA = a.sharedSecret(b.publicSpki);
    const sharedByB = b.sharedSecret(a.publicSpki);
    expect(sharedByA).toEqual(sharedByB);
  });

  it('publicSpki is 309 bytes', () => {
    const a = sessionKeyPairFromScalar('wei25519', SCALAR_A);
    expect(a.publicSpki.length).toBe(309);
  });
});

describe('peer key is parsed before the mode check', () => {
  it('reports an off-curve wei25519 peer as invalid_point in an x25519 session', () => {
    const xPair = sessionKeyPairFromScalar('x25519', SCALAR_A);
    const offCurve = Uint8Array.from(sessionKeyPairFromScalar('wei25519', SCALAR_B).publicSpki);
    offCurve[offCurve.length - 1] = (offCurve[offCurve.length - 1] ?? 0) ^ 0x01;

    expect(() => xPair.sharedSecret(offCurve)).toThrow(
      expect.objectContaining({ code: 'invalid_point' }),
    );
  });
});

describe('mode mismatch', () => {
  it('rejects a peer SPKI of the other mode as bad_key_material', () => {
    const weiPair = sessionKeyPairFromScalar('wei25519', SCALAR_A);
    const x25519Peer = sessionKeyPairFromScalar('x25519', fromHex(golden.fiu.private_key_raw_hex));

    try {
      weiPair.sharedSecret(x25519Peer.publicSpki);
      throw new Error('expected sharedSecret to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KeyError);
      expect((e as KeyError).code).toBe('bad_key_material');
    }
  });
});

describe('small-order x25519 peer', () => {
  it('rejects an all-zero Montgomery u (u = 0) as invalid_point', () => {
    const pair = sessionKeyPairFromScalar('x25519', fromHex(golden.fip.private_key_raw_hex));
    // 44-byte X25519 SPKI: fixed 12-byte OID prefix + a 32-byte all-zero u,
    // the canonical small-order point whose ECDH output is always all-zero.
    const smallOrderSpki = new Uint8Array([
      ...fromHex('302a300506032b656e032100'),
      ...new Uint8Array(32),
    ]);

    try {
      pair.sharedSecret(smallOrderSpki);
      throw new Error('expected sharedSecret to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KeyError);
      expect((e as KeyError).code).toBe('invalid_point');
    }
  });
});

describe('spkiMode', () => {
  it('detects wei25519 by its explicit-parameters SPKI prefix', () => {
    const pair = sessionKeyPairFromScalar('wei25519', SCALAR_A);
    expect(spkiMode(pair.publicSpki)).toBe('wei25519');
  });

  it('detects x25519 by its named-curve OID', () => {
    expect(spkiMode(fromHex(golden.fip.public_key_spki_hex))).toBe('x25519');
  });

  it('rejects an SPKI that matches neither template as bad_key_material', () => {
    try {
      spkiMode(new Uint8Array([1, 2, 3, 4]));
      throw new Error('expected spkiMode to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KeyError);
      expect((e as KeyError).code).toBe('bad_key_material');
    }
  });
});
