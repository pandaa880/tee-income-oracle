/** ReBIT `KeyMaterial` (FORMATS §3), as emitted: clean labels, single-line PEM. */

import { b64Encode, derToSingleLinePem } from '../crypto/encoding.ts';

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
