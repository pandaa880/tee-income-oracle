import { describe, expect, it } from 'vitest';

import { decrypt, deriveSessionKey } from '../crypto/cipher.ts';
import { sessionKeyPairFromScalar, type KeyMode } from '../crypto/ecdh.ts';
import { b64Decode, pemToDer, utf8 } from '../crypto/encoding.ts';
import { signDetached, verifyDetached } from '../crypto/jws.ts';
import { testKeys } from '../testing/fixtures.ts';
import { pinned } from '../vectors/keys.ts';
import { buildKeyMaterial } from './key-material.ts';
import { seal } from './seal.ts';

const keys = testKeys();
const FI = utf8('{"type":"DEPOSIT","note":"seal test statement"}');
const ENCLAVE_NONCE = new Uint8Array(32).fill(0x31);
const FIP_NONCE = new Uint8Array(32).fill(0x42);
const FIP_SCALAR = new Uint8Array(32).fill(0x53);
const EXPIRY = 1_790_503_200;

function sealFor(mode: KeyMode, fi = FI) {
  const enclave = sessionKeyPairFromScalar(mode, keys.enclaveScalar);
  const sealed = seal({
    fi,
    fipKey: keys.fip,
    peerSpki: enclave.publicSpki,
    peerNonce: ENCLAVE_NONCE,
    fipScalar: FIP_SCALAR,
    fipNonce: FIP_NONCE,
    expiryUnix: EXPIRY,
  });
  return { enclave, sealed };
}

/** What the enclave does with the fetch response: ECDH with the FIP's key, derive, decrypt. */
function openAsEnclave(mode: KeyMode, sealed: ReturnType<typeof sealFor>['sealed']) {
  const enclave = sessionKeyPairFromScalar(mode, keys.enclaveScalar);
  const fipSpki = pemToDer(sealed.keyMaterial.DHPublicKey.KeyValue);
  const fipNonce = b64Decode(sealed.keyMaterial.Nonce);
  const key = deriveSessionKey(enclave.sharedSecret(fipSpki), ENCLAVE_NONCE, fipNonce);
  const plaintext = decrypt(key, sealed.encryptedFi);
  return JSON.parse(Buffer.from(plaintext).toString('utf8')) as { fi: string; jws: string };
}

describe.each(['wei25519', 'x25519'] as const)('seal (%s)', (mode) => {
  it('the enclave can decrypt it and gets the FI bytes back', () => {
    const { sealed } = sealFor(mode);
    const envelope = openAsEnclave(mode, sealed);
    expect(Buffer.from(b64Decode(envelope.fi)).toString('utf8')).toBe(
      Buffer.from(FI).toString('utf8'),
    );
  });

  it('carries a FIP detached JWS over the FI bytes that verifies with the pinned FIP key', () => {
    const { sealed } = sealFor(mode);
    const envelope = openAsEnclave(mode, sealed);
    expect(verifyDetached(envelope.jws, b64Decode(envelope.fi), [pinned(keys.fip)])).toEqual({
      ok: true,
      value: null,
    });
  });

  it("does not verify under the AA key (the signature is the FIP's)", () => {
    const { sealed } = sealFor(mode);
    const envelope = openAsEnclave(mode, sealed);
    expect(verifyDetached(envelope.jws, b64Decode(envelope.fi), [pinned(keys.aa)]).ok).toBe(false);
  });

  it('returns the FIP key material in the same mode as the peer key', () => {
    const { sealed } = sealFor(mode);
    const fip = sessionKeyPairFromScalar(mode, FIP_SCALAR);
    expect(sealed.keyMaterial).toEqual(buildKeyMaterial(fip.publicSpki, FIP_NONCE, EXPIRY));
  });

  it('is deterministic for fixed scalar and nonce (so the test vectors stay byte-identical)', () => {
    expect(sealFor(mode).sealed).toEqual(sealFor(mode).sealed);
  });

  it('a different FI gives a different ciphertext', () => {
    expect(sealFor(mode, utf8('{"other":1}')).sealed.encryptedFi).not.toBe(
      sealFor(mode).sealed.encryptedFi,
    );
  });
});

describe('seal with the wrong enclave key', () => {
  it('cannot be opened with another scalar', () => {
    const { sealed } = sealFor('x25519');
    const other = sessionKeyPairFromScalar('x25519', new Uint8Array(32).fill(0x99));
    const key = deriveSessionKey(
      other.sharedSecret(pemToDer(sealed.keyMaterial.DHPublicKey.KeyValue)),
      ENCLAVE_NONCE,
      b64Decode(sealed.keyMaterial.Nonce),
    );
    expect(() => decrypt(key, sealed.encryptedFi)).toThrow();
  });

  it('signs with the key it is given', () => {
    const { sealed } = sealFor('x25519');
    const envelope = openAsEnclave('x25519', sealed);
    expect(envelope.jws).toBe(signDetached(b64Decode(envelope.fi), keys.fip));
  });
});
