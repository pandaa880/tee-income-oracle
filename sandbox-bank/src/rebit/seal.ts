/**
 * FIP side of the FI fetch response (FORMATS §3, §5.2): sign the FI bytes,
 * wrap them in the `{fi, jws}` envelope and encrypt the envelope to the
 * enclave's session key. Used by the live bank and the vector generator.
 */

import { deriveSessionKey, encrypt } from '../crypto/cipher.ts';
import { sessionKeyPairFromScalar, spkiMode } from '../crypto/ecdh.ts';
import { jsonBytes } from '../crypto/encoding.ts';
import { signDetached, type RsaKey } from '../crypto/jws.ts';
import { buildFipEnvelope } from './fetch-response.ts';
import { buildKeyMaterial, type KeyMaterial } from './key-material.ts';

/** The peer's session key, the FIP's one-time key and the KeyMaterial expiry. */
export interface SealKeys {
  readonly peerSpki: Uint8Array;
  readonly peerNonce: Uint8Array;
  /** 32 random bytes in production; fixed per case in the vectors. */
  readonly fipScalar: Uint8Array;
  readonly fipNonce: Uint8Array;
  readonly expiryUnix: number;
}

export interface Sealed {
  readonly encryptedFi: string;
  readonly keyMaterial: KeyMaterial;
}

/** Signs `fi` with the FIP key, wraps it and encrypts the envelope to the peer. */
export function seal(a: SealKeys & { readonly fi: Uint8Array; readonly fipKey: RsaKey }): Sealed {
  const envelope = buildFipEnvelope(a.fi, signDetached(a.fi, a.fipKey));
  return encryptToPeer(a, jsonBytes(envelope, 0));
}

/**
 * Encrypts `plaintext` to the peer: a FIP key pair in the peer key's mode
 * (decided by its SPKI), ECDH, then the §3 key derivation with the FIP nonce
 * as ours. Throws `KeyError` for a bad or off-curve peer key and
 * `DecryptError('bad_nonce')` for a nonce that isn't 32 bytes.
 */
export function encryptToPeer(k: SealKeys, plaintext: Uint8Array): Sealed {
  const fip = sessionKeyPairFromScalar(spkiMode(k.peerSpki), k.fipScalar);
  const key = deriveSessionKey(fip.sharedSecret(k.peerSpki), k.fipNonce, k.peerNonce);
  return {
    encryptedFi: encrypt(key, plaintext),
    keyMaterial: buildKeyMaterial(fip.publicSpki, k.fipNonce, k.expiryUnix),
  };
}
