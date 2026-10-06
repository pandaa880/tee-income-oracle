/** RSA-2048 key generation as JWKs (FORMATS §2: RSA-2048, `kid` = UUIDv4). */

import { generateKeyPairSync, randomUUID } from 'node:crypto';

export interface RsaPublicJwk {
  readonly kty: 'RSA';
  readonly n: string;
  readonly e: string;
  readonly kid: string;
}

export interface RsaJwkPair {
  /** Private JWK with `kid`. Never logged, never committed outside test-vectors/. */
  readonly privateJwk: Readonly<Record<string, unknown>>;
  /** Exactly `kty`, `n`, `e`, `kid`: what gets pinned. */
  readonly publicJwk: RsaPublicJwk;
}

/** A fresh RSA-2048 key (e = 65537) with a random `kid`. */
export function generateRsaJwkPair(): RsaJwkPair {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const kid = randomUUID();
  const jwk = privateKey.export({ format: 'jwk' });
  if (jwk.n === undefined || jwk.e === undefined) {
    throw new Error('RSA JWK export is missing n or e');
  }
  return { privateJwk: { ...jwk, kid }, publicJwk: { kty: 'RSA', n: jwk.n, e: jwk.e, kid } };
}
