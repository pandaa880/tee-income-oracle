/**
 * Live bank configuration from the environment (FORMATS §2: demo keys are
 * never committed; they arrive as secrets). Refuses to start on anything
 * that would let the bank sign with a key the enclave doesn't pin:
 * - a key flagged `private_key_test_only` (a committed test-vector key),
 * - an RSA key under 2048 bits,
 * - a key whose public half (`e, kid, kty, n`) differs from the pinned file
 *   `<PINNED_DIR>/{aa,fip}.jwk.json`. The enclave refuses test keys in its
 *   pins at boot, so pin equality also keeps test keys out of the bank.
 * Error messages name the variable or file, never key material.
 */

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { RsaKey } from '../crypto/jws.ts';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface Config {
  readonly aa: RsaKey;
  readonly fip: RsaKey;
  readonly rpcUrl: string;
  readonly programId: string;
  readonly port: number;
  readonly pinnedDir: string;
}

/** The oracle program (FORMATS §13). */
const ORACLE_PROGRAM_ID = 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8';
const DEFAULT_PINNED_DIR = fileURLToPath(new URL('../../../enclave/pinned/', import.meta.url));
const MIN_RSA_BITS = 2048;

const EnvSchema = z.object({
  SANDBOX_AA_PRIVATE_JWK: z.string().min(1),
  SANDBOX_FIP_PRIVATE_JWK: z.string().min(1),
  SOLANA_RPC_URL: z.string().min(1),
  ORACLE_PROGRAM_ID: z.string().min(1).default(ORACLE_PROGRAM_ID),
  PORT: z
    .string()
    .regex(/^[0-9]+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535))
    .default(8081),
  PINNED_DIR: z.string().min(1).default(DEFAULT_PINNED_DIR),
});

const PrivateJwkSchema = z.looseObject({
  kty: z.literal('RSA'),
  kid: z.string().min(1),
  n: z.string().min(1),
  e: z.string().min(1),
  d: z.string().min(1),
});

const PublicJwkSchema = z.strictObject({
  kty: z.literal('RSA'),
  kid: z.string().min(1),
  n: z.string().min(1),
  e: z.string().min(1),
});

/** Throws `ConfigError` on any missing, malformed or unpinned value. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`invalid environment: ${names}`);
  }
  const vars = parsed.data;
  return {
    aa: loadKey('SANDBOX_AA_PRIVATE_JWK', vars.SANDBOX_AA_PRIVATE_JWK, vars.PINNED_DIR, 'aa'),
    fip: loadKey('SANDBOX_FIP_PRIVATE_JWK', vars.SANDBOX_FIP_PRIVATE_JWK, vars.PINNED_DIR, 'fip'),
    rpcUrl: vars.SOLANA_RPC_URL,
    programId: vars.ORACLE_PROGRAM_ID,
    port: vars.PORT,
    pinnedDir: vars.PINNED_DIR,
  };
}

function loadKey(variable: string, text: string, pinnedDir: string, name: 'aa' | 'fip'): RsaKey {
  const jwk = PrivateJwkSchema.safeParse(parseJson(text, variable));
  if (!jwk.success) {
    throw new ConfigError(`${variable}: not an RSA private JWK with a kid`);
  }
  if (jwk.data['private_key_test_only'] !== undefined) {
    throw new ConfigError(`${variable}: a test-only key; the live bank needs the demo keys`);
  }
  const privateKey = rsaPrivateKey(jwk.data, variable);
  const publicKey = createPublicKey(privateKey);
  const pinFile = join(pinnedDir, `${name}.jwk.json`);
  if (!samePublicKey(publicKey, jwk.data.kid, readPin(pinFile))) {
    throw new ConfigError(`${variable}: public half differs from ${pinFile}`);
  }
  return { kid: jwk.data.kid, privateKey, publicKey };
}

function rsaPrivateKey(jwk: z.infer<typeof PrivateJwkSchema>, variable: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new ConfigError(`${variable}: not a valid RSA private key`);
  }
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) {
    throw new ConfigError(`${variable}: RSA key shorter than ${MIN_RSA_BITS} bits`);
  }
  return key;
}

function readPin(file: string): z.infer<typeof PublicJwkSchema> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`${file}: pinned key file missing`);
  }
  const pin = PublicJwkSchema.safeParse(parseJson(text, file));
  if (!pin.success) {
    throw new ConfigError(`${file}: not a public RSA JWK (kty, kid, n, e)`);
  }
  return pin.data;
}

function samePublicKey(
  publicKey: KeyObject,
  kid: string,
  pin: z.infer<typeof PublicJwkSchema>,
): boolean {
  const ours = publicKey.export({ format: 'jwk' });
  return ours.n === pin.n && ours.e === pin.e && kid === pin.kid;
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError(`${source}: not JSON`);
  }
}
