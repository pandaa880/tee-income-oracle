/**
 * TEST-ONLY keys for the vectors (FORMATS §2). Generated once by
 * `gen:keys` and committed on purpose so anyone can reproduce the vectors.
 * Nothing deployed may trust them; the live sandbox bank uses separate,
 * never-committed demo keys.
 */

import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fromHex, toHex } from '../crypto/encoding.ts';
import type { PinnedKey, RsaKey } from '../crypto/jws.ts';
import { generateRsaJwkPair } from '../crypto/rsa-jwk.ts';

export const RSA_KEY_NAMES = ['fip', 'aa', 'fiu', 'rogue'] as const;
export type RsaKeyName = (typeof RSA_KEY_NAMES)[number];

export const ENCLAVE_KEY_FILE = 'enclave.test-private.json';

export interface TestKeys {
  readonly fip: RsaKey;
  readonly aa: RsaKey;
  readonly fiu: RsaKey;
  readonly rogue: RsaKey;
  readonly enclaveScalar: Uint8Array;
  readonly enclaveSecp256k1: Uint8Array;
}

/** Fresh key files (filename in `keys/` → text). Random: run once, then commit. */
export function generateKeyFiles(): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const name of RSA_KEY_NAMES) {
    const { privateJwk, publicJwk } = generateRsaJwkPair();
    files.set(
      `${name}.test-private.jwk.json`,
      json({ ...privateJwk, private_key_test_only: true }),
    );
    files.set(`${name}.public.jwk.json`, json(publicJwk));
  }
  files.set(
    ENCLAVE_KEY_FILE,
    json({
      curve25519_scalar_hex: toHex(randomBytes(32)),
      // Any 32 bytes below the secp256k1 order n; a random value is below it
      // with overwhelming probability, and code that signs with it must check the range on load.
      secp256k1_hex: toHex(randomBytes(32)),
      private_key_test_only: true,
    }),
  );
  return files;
}

/** Loads the committed test keys. */
export function loadTestKeys(keysDir: string): TestKeys {
  const enclave = readJsonObject(join(keysDir, ENCLAVE_KEY_FILE));
  return {
    fip: loadRsaKey(keysDir, 'fip'),
    aa: loadRsaKey(keysDir, 'aa'),
    fiu: loadRsaKey(keysDir, 'fiu'),
    rogue: loadRsaKey(keysDir, 'rogue'),
    enclaveScalar: fromHex(stringField(enclave, 'curve25519_scalar_hex')),
    enclaveSecp256k1: fromHex(stringField(enclave, 'secp256k1_hex')),
  };
}

/** The public half as a pinned key. */
export function pinned(key: RsaKey): PinnedKey {
  return { kid: key.kid, publicKey: key.publicKey };
}

function loadRsaKey(keysDir: string, name: RsaKeyName): RsaKey {
  const jwk = readJsonObject(join(keysDir, `${name}.test-private.jwk.json`));
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
  return { kid: stringField(jwk, 'kid'), privateKey, publicKey: createPublicKey(privateKey) };
}

/**
 * String members of a TEST-ONLY private key file. Refuses any file without
 * `"private_key_test_only": true`, so a real key dropped at one of these
 * paths is never used to sign vectors (AGENTS invariant 9).
 */
function readJsonObject(path: string): Record<string, string> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  if (!('private_key_test_only' in value) || value.private_key_test_only !== true) {
    throw new Error(`${path}: not flagged private_key_test_only`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

function stringField(obj: Record<string, string>, field: string): string {
  const v = obj[field];
  if (v === undefined) {
    throw new Error(`missing string field ${field}`);
  }
  return v;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
