/** ReBIT `KeyMaterial` (FORMATS §3), as emitted: clean labels, single-line PEM. */

import { DecryptError } from '../crypto/cipher.ts';
import { spkiMode } from '../crypto/ecdh.ts';
import { KeyError } from '../crypto/key-error.ts';
import { b64Decode, b64Encode, derToSingleLinePem, pemToDer } from '../crypto/encoding.ts';

export type KeyMaterial = {
  readonly cryptoAlg: string;
  readonly curve: string;
  readonly params: string;
  readonly DHPublicKey: {
    readonly expiry: string;
    readonly Parameters: string;
    readonly KeyValue: string;
  };
  readonly Nonce: string;
};

/** Same fields and values as tio-core's `KeyMaterial::new`. */
export function buildKeyMaterial(
  publicSpki: Uint8Array,
  nonce: Uint8Array,
  expiryUnix: number,
): KeyMaterial {
  return {
    cryptoAlg: 'ECDH',
    curve: 'Curve25519',
    params: '',
    DHPublicKey: {
      expiry: isoUtc(expiryUnix),
      Parameters: '',
      KeyValue: derToSingleLinePem(publicSpki),
    },
    Nonce: b64Encode(nonce),
  };
}

/** `yyyy-MM-ddTHH:mm:ss.SSSZ` for whole unix seconds (FORMATS §0). */
export function isoUtc(unixSecs: number): string {
  return new Date(unixSecs * 1000).toISOString();
}

/** The peer's public key and nonce from a received `KeyMaterial`. */
export interface PeerKey {
  readonly spki: Uint8Array;
  readonly nonce: Uint8Array;
}

const NONCE_LEN = 32;

/**
 * Reads the members we use from an untrusted `KeyMaterial` (FORMATS §3).
 * Labels (`cryptoAlg`, `curve`, `params`) are ignored: the SPKI decides the
 * mode. A bad shape or an unknown SPKI → `KeyError('bad_key_material')`; a
 * nonce that isn't 32 bytes of base64 → `DecryptError('bad_nonce')`.
 * Off-curve points surface later, from the key exchange (`invalid_point`).
 */
export function parseKeyMaterial(km: unknown): PeerKey {
  const keyValue = member(member(km, 'DHPublicKey'), 'KeyValue');
  const nonceB64 = member(km, 'Nonce');
  if (typeof keyValue !== 'string' || typeof nonceB64 !== 'string') {
    throw new KeyError('bad_key_material');
  }
  const spki = decodeOr(
    () => pemToDer(keyValue),
    (cause) => new KeyError('bad_key_material', { cause }),
  );
  spkiMode(spki);
  const nonce = decodeOr(
    () => b64Decode(nonceB64),
    (cause) => new DecryptError('bad_nonce', { cause }),
  );
  if (nonce.length !== NONCE_LEN) {
    throw new DecryptError('bad_nonce');
  }
  return { spki, nonce };
}

function member(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.hasOwn(value, name) ? (Reflect.get(value, name) as unknown) : undefined;
}

function decodeOr(decode: () => Uint8Array, error: (cause: unknown) => Error): Uint8Array {
  try {
    return decode();
  } catch (cause) {
    throw error(cause);
  }
}
