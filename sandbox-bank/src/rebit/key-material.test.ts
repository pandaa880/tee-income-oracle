import { describe, expect, it } from 'vitest';

import { DecryptError } from '../crypto/cipher.ts';
import { KeyError, sessionKeyPairFromScalar, type KeyMode } from '../crypto/ecdh.ts';
import { b64Encode, toHex } from '../crypto/encoding.ts';
import { buildKeyMaterial } from './key-material.ts';
import { parseKeyMaterial } from './key-material.ts';

const SCALAR = new Uint8Array(32).fill(0x07);
const NONCE = new Uint8Array(32).fill(0x09);

function material(mode: KeyMode) {
  const pair = sessionKeyPairFromScalar(mode, SCALAR);
  return { pair, km: buildKeyMaterial(pair.publicSpki, NONCE, 1_790_503_200) };
}

describe('parseKeyMaterial', () => {
  it.each(['wei25519', 'x25519'] as const)('round-trips a %s KeyMaterial', (mode) => {
    const { pair, km } = material(mode);
    const parsed = parseKeyMaterial(km);
    expect(toHex(parsed.spki)).toBe(toHex(pair.publicSpki));
    expect(toHex(parsed.nonce)).toBe(toHex(NONCE));
  });

  it('accepts multi-line PEM and ignores the labels (FORMATS §12)', () => {
    const { km } = material('x25519');
    const lines = km.DHPublicKey.KeyValue.replace('-----BEGIN PUBLIC KEY-----', '').replace(
      '-----END PUBLIC KEY-----',
      '',
    );
    const pem = `-----BEGIN PUBLIC KEY-----\n${lines.slice(0, 20)}\n${lines.slice(20)}\n-----END PUBLIC KEY-----`;
    const relabelled = { ...km, cryptoAlg: null, curve: 'ECDH', params: 'Curve25519' };
    const parsed = parseKeyMaterial({
      ...relabelled,
      DHPublicKey: { ...km.DHPublicKey, KeyValue: pem },
    });
    expect(parsed.spki).toHaveLength(44);
  });

  it.each([null, 'text', 42, [], {}, { DHPublicKey: {}, Nonce: 'x' }])(
    'rejects a non-KeyMaterial value %j with bad_key_material',
    (value) => {
      expect(() => parseKeyMaterial(value)).toThrow(KeyError);
      try {
        parseKeyMaterial(value);
      } catch (e) {
        expect((e as KeyError).code).toBe('bad_key_material');
      }
    },
  );

  it('rejects an SPKI that is neither wei25519 nor X25519', () => {
    const { km } = material('x25519');
    const bad = {
      ...km,
      DHPublicKey: { ...km.DHPublicKey, KeyValue: b64Encode(new Uint8Array(40)) },
    };
    expect(() => parseKeyMaterial(bad)).toThrow(KeyError);
  });

  it('rejects a nonce that is not 32 bytes with bad_nonce', () => {
    const { km } = material('x25519');
    const short = { ...km, Nonce: b64Encode(new Uint8Array(16)) };
    expect(() => parseKeyMaterial(short)).toThrow(DecryptError);
  });

  it('rejects a nonce that is not base64 with bad_nonce', () => {
    const { km } = material('x25519');
    expect(() => parseKeyMaterial({ ...km, Nonce: '***' })).toThrow(DecryptError);
  });
});
