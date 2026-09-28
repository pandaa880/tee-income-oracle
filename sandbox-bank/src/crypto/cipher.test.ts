import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { b64Decode, fromHex, toHex, utf8 } from './encoding.ts';
import { DecryptError, decrypt, deriveSessionKey, encrypt } from './cipher.ts';

interface CipherFixture {
  readonly fip_nonce_b64: string;
  readonly fiu_nonce_b64: string;
  readonly shared_secret_hex: string;
  readonly plaintext: string;
  readonly ciphertext_b64: string;
  readonly aes_key_hex: string;
  readonly iv_hex: string;
}

function readGoldenJson(relativePath: string): unknown {
  const url = new URL(`../../../test-vectors/golden/${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

function checkFixture(fixture: CipherFixture, label: string): void {
  it(`${label}: deriveSessionKey reproduces the golden aes_key and iv`, () => {
    const shared = fromHex(fixture.shared_secret_hex);
    const fiuNonce = b64Decode(fixture.fiu_nonce_b64);
    const fipNonce = b64Decode(fixture.fip_nonce_b64);

    const key = deriveSessionKey(shared, fiuNonce, fipNonce);
    expect(toHex(key.key)).toBe(fixture.aes_key_hex);
    expect(toHex(key.iv)).toBe(fixture.iv_hex);

    // XOR is symmetric: swapping which nonce is "ours" must not change
    // the derived key or IV.
    const swapped = deriveSessionKey(shared, fipNonce, fiuNonce);
    expect(toHex(swapped.key)).toBe(fixture.aes_key_hex);
    expect(toHex(swapped.iv)).toBe(fixture.iv_hex);
  });

  it(`${label}: decrypt reproduces the golden plaintext`, () => {
    const shared = fromHex(fixture.shared_secret_hex);
    const key = deriveSessionKey(
      shared,
      b64Decode(fixture.fiu_nonce_b64),
      b64Decode(fixture.fip_nonce_b64),
    );
    expect(decrypt(key, fixture.ciphertext_b64)).toEqual(utf8(fixture.plaintext));
  });

  it(`${label}: encrypt reproduces the golden ciphertext`, () => {
    const shared = fromHex(fixture.shared_secret_hex);
    const key = deriveSessionKey(
      shared,
      b64Decode(fixture.fiu_nonce_b64),
      b64Decode(fixture.fip_nonce_b64),
    );
    expect(encrypt(key, utf8(fixture.plaintext))).toBe(fixture.ciphertext_b64);
  });
}

describe('golden anchor: rahasya ecc.json', () => {
  const ecc = readGoldenJson('rahasya/ecc.json') as { vectors: readonly CipherFixture[] };
  ecc.vectors.forEach((vector, i) => checkFixture(vector, `ecc vector ${i}`));
});

describe('golden anchor: rahasya x25519.json', () => {
  const x25519 = readGoldenJson('rahasya/x25519.json') as CipherFixture;
  checkFixture(x25519, 'x25519');
});

describe('deriveSessionKey nonce length', () => {
  it('rejects a nonce that is not exactly 32 bytes as bad_nonce', () => {
    const shared = new Uint8Array(32).fill(1);
    const short = new Uint8Array(31);
    const valid = new Uint8Array(32);

    try {
      deriveSessionKey(shared, short, valid);
      throw new Error('expected deriveSessionKey to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DecryptError);
      expect((e as DecryptError).code).toBe('bad_nonce');
    }
  });
});

describe('decrypt failures', () => {
  const x25519 = readGoldenJson('rahasya/x25519.json') as CipherFixture;
  const key = deriveSessionKey(
    fromHex(x25519.shared_secret_hex),
    b64Decode(x25519.fiu_nonce_b64),
    b64Decode(x25519.fip_nonce_b64),
  );

  it('rejects a flipped ciphertext/tag byte as decrypt_failed', () => {
    const raw = Buffer.from(x25519.ciphertext_b64, 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0x01;
    const tampered = raw.toString('base64');

    try {
      decrypt(key, tampered);
      throw new Error('expected decrypt to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DecryptError);
      expect((e as DecryptError).code).toBe('decrypt_failed');
    }
  });

  it('rejects invalid base64 as decrypt_failed', () => {
    try {
      decrypt(key, 'not-valid-base64!!');
      throw new Error('expected decrypt to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DecryptError);
      expect((e as DecryptError).code).toBe('decrypt_failed');
    }
  });
});
