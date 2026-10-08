/**
 * Shared helpers for the live-service tests: the committed test keys standing in for
 * the demo keys, an independent (noble-based) model of the enclave's §8.1 binding
 * signature, a counter-based random source and a fake attester registry.
 * Test code only: nothing here may be imported by the service.
 */

import { createHash } from 'node:crypto';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import { toHex, utf8 } from '../crypto/encoding.ts';
import { canonicalize } from '../crypto/jcs.ts';
import type { RsaKey } from '../crypto/jws.ts';
import type { RsaPublicJwk } from '../crypto/rsa-jwk.ts';
import type { AttesterRegistry, RegistryResult } from '../chain/registry.ts';
import { KEYS_DIR } from '../vectors/paths.ts';
import { loadTestKeys, type TestKeys } from '../vectors/keys.ts';

/** secp256k1 group order n. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export function testKeys(): TestKeys {
  return loadTestKeys(KEYS_DIR);
}

/** The public JWK of a test RSA key, with exactly the §8.1 members. */
export function publicJwk(key: RsaKey): RsaPublicJwk {
  const jwk = key.publicKey.export({ format: 'jwk' });
  if (jwk.n === undefined || jwk.e === undefined) {
    throw new Error('RSA JWK export is missing n or e');
  }
  return { kty: 'RSA', n: jwk.n, e: jwk.e, kid: key.kid };
}

/** sha256 of the JCS form of the JWK, as FORMATS §8.1 hashes it. */
export function jwkDigest(jwk: RsaPublicJwk): Uint8Array {
  const jcs = canonicalize({ e: jwk.e, kid: jwk.kid, kty: jwk.kty, n: jwk.n });
  return new Uint8Array(createHash('sha256').update(utf8(jcs)).digest());
}

/** The 46-byte §8.1 message, built independently of the code under test. */
export function bindingMessage(jwk: RsaPublicJwk): Uint8Array {
  return Uint8Array.from([...utf8('TIO-FIU-KEY-v1'), ...jwkDigest(jwk)]);
}

/** Eth-style address (20 bytes) of a secp256k1 private key. */
export function attesterAddress(privateKey: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.getPublicKey(privateKey, false);
  return keccak_256(uncompressed.subarray(1)).subarray(12);
}

export function addressHex(address: Uint8Array): string {
  return `0x${toHex(address)}`;
}

/** r ‖ s ‖ v (65 bytes, low-s, v in {0,1}) over keccak256(msg). Noble's 'recovered' puts v first. */
export function signRecoverable(msg: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const recovered = secp256k1.sign(keccak_256(msg), privateKey, {
    prehash: false,
    format: 'recovered',
  });
  return Uint8Array.from([...recovered.subarray(1), recovered[0] ?? 0]);
}

/** `fiu_key_signature_hex` as the enclave's `GET /v1/info` returns it. */
export function bindingSignatureHex(jwk: RsaPublicJwk, privateKey: Uint8Array): string {
  return toHex(signRecoverable(bindingMessage(jwk), privateKey));
}

/** Distinct, deterministic, valid-as-scalar bytes for every call. */
export function counterRandom(): (n: number) => Uint8Array {
  let counter = 0;
  return (n) => {
    counter += 1;
    const out = new Uint8Array(n);
    for (let block = 0; block * 32 < n; block += 1) {
      const digest = createHash('sha256').update(`tio-test-random-${counter}-${block}`).digest();
      out.set(digest.subarray(0, Math.min(32, n - block * 32)), block * 32);
    }
    return out;
  };
}

export interface FakeRegistry extends AttesterRegistry {
  /** Lower-case hex of the attesters that count as active. */
  readonly active: Set<string>;
  /** When true, `isActive` reports an RPC outage. */
  down: boolean;
  calls: number;
}

export function fakeRegistry(): FakeRegistry {
  const registry: FakeRegistry = {
    active: new Set(),
    down: false,
    calls: 0,
    isActive(attester: Uint8Array): Promise<RegistryResult> {
      registry.calls += 1;
      if (registry.down) {
        return Promise.resolve({ ok: false });
      }
      return Promise.resolve({ ok: true, active: registry.active.has(toHex(attester)) });
    },
  };
  return registry;
}
