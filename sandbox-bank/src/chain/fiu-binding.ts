/**
 * FIU key binding (FORMATS §8.1): the enclave's attester key signs the FIU
 * request key once per boot, so the bank can tie an FIU key to a registered
 * enclave. Only the attester key is in the Nitro attestation document.
 *
 *   msg = "TIO-FIU-KEY-v1" (14 B) ‖ sha256(JCS(fiu_public_jwk)) (32 B)
 *   sig = r ‖ s ‖ v over keccak256(msg), low-s, v ∈ {0, 1}
 *
 * Node has no keccak and no recoverable ECDSA, hence noble here and not in
 * `crypto/` (which stays node:crypto only).
 */

import { createHash } from 'node:crypto';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import { utf8 } from '../crypto/encoding.ts';
import { canonicalize } from '../crypto/jcs.ts';
import type { RsaPublicJwk } from '../crypto/rsa-jwk.ts';

export const FIU_KEY_TAG = 'TIO-FIU-KEY-v1';

const SIGNATURE_LEN = 65;
const ADDRESS_LEN = 20;

/** The 46-byte message the attester signs. JWK members exactly `e, kid, kty, n`. */
export function fiuBindingMessage(jwk: RsaPublicJwk): Uint8Array {
  const jcs = canonicalize({ e: jwk.e, kid: jwk.kid, kty: jwk.kty, n: jwk.n });
  const digest = createHash('sha256').update(utf8(jcs)).digest();
  return Uint8Array.from([...utf8(FIU_KEY_TAG), ...digest]);
}

/**
 * The Ethereum-style address (20 bytes) that signed `jwk`'s binding, or
 * `undefined` for a malformed signature: not 65 bytes, `v` not 0 or 1,
 * high-s (a malleated twin), or no recoverable key. A well-formed
 * signature over another message recovers some other address; the caller
 * decides by looking the address up in the registry.
 */
export function recoverAttester(sig65: Uint8Array, jwk: RsaPublicJwk): Uint8Array | undefined {
  const v = sig65[SIGNATURE_LEN - 1];
  if (sig65.length !== SIGNATURE_LEN || (v !== 0 && v !== 1)) {
    return undefined;
  }
  try {
    const sig = secp256k1.Signature.fromBytes(sig65.subarray(0, 64), 'compact').addRecoveryBit(v);
    if (sig.hasHighS()) {
      return undefined;
    }
    const publicKey = sig.recoverPublicKey(keccak_256(fiuBindingMessage(jwk))).toBytes(false);
    return keccak_256(publicKey.subarray(1)).slice(32 - ADDRESS_LEN);
  } catch {
    // Noble throws for r or s out of range and for an x with no curve point.
    return undefined;
  }
}
