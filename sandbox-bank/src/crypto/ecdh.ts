/**
 * Session key exchange in both FORMATS §3 modes. The secret scalar
 * multiplication is always X25519 from node:crypto (OpenSSL); `wei25519`
 * only changes how public keys and the shared secret are encoded.
 */

import { createPrivateKey, createPublicKey, diffieHellman, type KeyObject } from 'node:crypto';

import { fromHex } from './encoding.ts';
import { KeyError } from './key-error.ts';
import * as wei25519 from './wei25519.ts';

export { KeyError, type KeyErrorCode } from './key-error.ts';

export type KeyMode = 'wei25519' | 'x25519';

/** DER prefixes that wrap a raw 32-byte X25519 key (RFC 8410). */
const X25519_SPKI_PREFIX = fromHex('302a300506032b656e032100');
const X25519_PKCS8_PREFIX = fromHex('302e020100300506032b656e04220420');
const X25519_SPKI_LEN = 44;

export interface SessionKeyPair {
  readonly mode: KeyMode;
  readonly publicSpki: Uint8Array;
  sharedSecret(peerSpki: Uint8Array): Uint8Array;
}

/** Mode of a peer key, decided by its SPKI encoding alone (labels are never trusted). */
export function spkiMode(spki: Uint8Array): KeyMode {
  if (spki.length === wei25519.SPKI_LEN) {
    return 'wei25519';
  }
  if (spki.length === X25519_SPKI_LEN && startsWith(spki, X25519_SPKI_PREFIX)) {
    return 'x25519';
  }
  throw new KeyError('bad_key_material');
}

/**
 * Key pair from a fixed 32-byte scalar. X25519 clamps it (RFC 7748), the
 * same as tio-core's SessionKeyPair::generate, so both sides derive the
 * same public key from `keys/enclave.test-private.json`.
 */
export function sessionKeyPairFromScalar(mode: KeyMode, scalar: Uint8Array): SessionKeyPair {
  if (scalar.length !== 32) {
    throw new Error(`X25519 scalar must be 32 bytes, got ${scalar.length}`);
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
    format: 'der',
    type: 'pkcs8',
  });
  const u = rawPublicU(createPublicKey(privateKey));
  const publicSpki = mode === 'wei25519' ? wei25519.encodeSpki(u) : x25519Spki(u);
  return {
    mode,
    publicSpki,
    sharedSecret: (peerSpki) => sharedSecret(mode, privateKey, peerSpki),
  };
}

/**
 * Parse the peer key first, then compare modes, in the same order as
 * tio-core (`PeerPublicKey::from_spki_der`, then `shared_secret`), so a bad
 * point reports `invalid_point` whatever our own mode is.
 */
function sharedSecret(mode: KeyMode, privateKey: KeyObject, peerSpki: Uint8Array): Uint8Array {
  const peerMode = spkiMode(peerSpki);
  const peerU = peerMode === 'wei25519' ? wei25519.parseSpki(peerSpki) : peerSpki.subarray(12);
  // A BouncyCastle FIP can't have parsed an X25519 key: a mismatch means
  // keys were swapped somewhere.
  if (peerMode !== mode) {
    throw new KeyError('bad_key_material');
  }
  const s = x25519(privateKey, peerU);
  return mode === 'wei25519' ? wei25519.sharedFromU(s) : s;
}

/**
 * X25519 ladder. A small-order peer point gives the all-zero secret, known
 * to everyone: reject it (OpenSSL already refuses; the check keeps it
 * explicit).
 */
function x25519(privateKey: KeyObject, peerU: Uint8Array): Uint8Array {
  let s: Uint8Array;
  try {
    const publicKey = createPublicKey({
      key: x25519SpkiBuffer(peerU),
      format: 'der',
      type: 'spki',
    });
    s = new Uint8Array(diffieHellman({ privateKey, publicKey }));
  } catch (cause) {
    throw new KeyError('invalid_point', { cause });
  }
  if (s.every((b) => b === 0)) {
    throw new KeyError('invalid_point');
  }
  return s;
}

function rawPublicU(publicKey: KeyObject): Uint8Array {
  return new Uint8Array(publicKey.export({ format: 'der', type: 'spki' })).subarray(12);
}

function x25519Spki(u: Uint8Array): Uint8Array {
  return new Uint8Array(x25519SpkiBuffer(u));
}

function x25519SpkiBuffer(u: Uint8Array): Buffer {
  return Buffer.concat([X25519_SPKI_PREFIX, u]);
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}
