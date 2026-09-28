/**
 * Curve25519 in short-Weierstrass form, as BouncyCastle (and so rahasya and
 * Finvu) encode it (FORMATS §3). Only public values pass through here: the
 * secret scalar multiplication is X25519 in node:crypto. The Weierstrass form
 * is the same group under x_W = u + A/3, so this module only converts
 * between the two encodings.
 *
 * Mirrors tio-core/src/ecdh/wei25519.rs; SPKI bytes must match it exactly,
 * including which square root is chosen for y.
 */

import { fromHex } from './encoding.ts';
import { KeyError } from './key-error.ts';

/** Field prime 2^255 − 19. */
export const P = 2n ** 255n - 19n;
/** A/3 mod p, with Montgomery A = 486662. */
export const A_OVER_3 = 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad2451n;
/** Weierstrass a = (3 − A²)/3. */
const CURVE_A = 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa984914a144n;
/** Weierstrass b = (2A³ − 9A)/27. */
const CURVE_B = 0x7b425ed097b425ed097b425ed097b425ed097b425ed097b4260b5e9c7710c864n;
/** (p + 3)/8: square-root exponent for p ≡ 5 (mod 8). */
const SQRT_EXP = (P + 3n) / 8n;
/** 2^((p − 1)/4) is a square root of −1. */
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

export const SPKI_LEN = 309;

/**
 * Everything before the coordinates in a BouncyCastle Curve25519 SPKI:
 * id-ecPublicKey, explicit curve parameters (p, a, b, G, n, h = 8, no seed)
 * and the BIT STRING header with the uncompressed-point tag 04. Same bytes
 * as tio-core's SPKI_PREFIX; comparing it whole validates every parameter.
 */
const SPKI_PREFIX = fromHex(
  '308201313081ea06072a8648ce3d02013081de020101302b06072a8648ce3d01010220' +
    '7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed3044' +
    '04202aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa984914a144' +
    '04207b425ed097b425ed097b425ed097b425ed097b425ed097b4260b5e9c7710c864' +
    '0441042aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad245a' +
    '20ae19a1b8a086b4e01edd2c7748d14c923d4d7e6d7c61b229e9c5a27eced3d90220' +
    '1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed0201' +
    '0803420004',
);

/** Montgomery u (32 bytes LE) → 309-byte wei25519 SPKI. */
export function encodeSpki(u: Uint8Array): Uint8Array {
  const x = mod(leToBig(u) + A_OVER_3);
  const y = sqrt(curveRhs(x));
  if (y === undefined) {
    throw new KeyError('invalid_point');
  }
  const der = new Uint8Array(SPKI_LEN);
  der.set(SPKI_PREFIX);
  der.set(bigToBe(x), SPKI_PREFIX.length);
  der.set(bigToBe(y), SPKI_PREFIX.length + 32);
  return der;
}

/**
 * 309-byte wei25519 SPKI → Montgomery u (32 bytes LE). The on-curve check
 * stops invalid-curve and twist points, which an x-only ladder would accept.
 */
export function parseSpki(der: Uint8Array): Uint8Array {
  if (der.length !== SPKI_LEN || !startsWith(der, SPKI_PREFIX)) {
    throw new KeyError('bad_key_material');
  }
  const x = fieldElement(der.subarray(SPKI_PREFIX.length, SPKI_PREFIX.length + 32));
  const y = fieldElement(der.subarray(SPKI_PREFIX.length + 32));
  if (mod(y * y) !== curveRhs(x)) {
    throw new KeyError('invalid_point');
  }
  return bigToLe(mod(x - A_OVER_3));
}

/** Shared-secret bytes: x_W = u + A/3 as 32 bytes big-endian (BouncyCastle ECDH). */
export function sharedFromU(u: Uint8Array): Uint8Array {
  return bigToBe(mod(leToBig(u) + A_OVER_3));
}

function curveRhs(x: bigint): bigint {
  return mod(x * x * x + CURVE_A * x + CURVE_B);
}

/** Atkin square root for p ≡ 5 (mod 8), same root choice as tio-core. */
function sqrt(z: bigint): bigint | undefined {
  const r = modPow(z, SQRT_EXP);
  if (mod(r * r) === z) {
    return r;
  }
  if (mod(r * r) === mod(-z)) {
    return mod(r * SQRT_M1);
  }
  return undefined;
}

/** A 32-byte big-endian coordinate that must already be below p. */
function fieldElement(bytes: Uint8Array): bigint {
  const n = beToBig(bytes);
  if (n >= P) {
    throw new KeyError('invalid_point');
  }
  return n;
}

function mod(n: bigint): bigint {
  const r = n % P;
  return r < 0n ? r + P : r;
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) {
      result = mod(result * b);
    }
    b = mod(b * b);
  }
  return result;
}

function beToBig(bytes: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
}

function leToBig(bytes: Uint8Array): bigint {
  return beToBig(bytes.toReversed());
}

function bigToBe(n: bigint): Uint8Array {
  return fromHex(n.toString(16).padStart(64, '0'));
}

function bigToLe(n: bigint): Uint8Array {
  return bigToBe(n).toReversed();
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}
