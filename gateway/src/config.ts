/**
 * Gateway configuration from the environment. Every problem is a
 * `ConfigError` naming the variable; secret values are never repeated.
 *
 *   ENCLAVE_URL, BANK_URL, SOLANA_RPC_URL   http(s) URLs (required)
 *   SOLANA_WS_URL                           default: the RPC URL as ws(s), port 8899 → 8900
 *   CLUSTER                                 reads deployments/<cluster>.json (required)
 *   MEASUREMENT_ID                          this enclave's registry id, 0..254 (required)
 *   POLICY_PATH                             default test-vectors/policy/default.json
 *   RELAYER_KEYPAIR                         Solana CLI keypair JSON (64 bytes; required)
 *   PORT                                    default 8082
 *   ALLOWED_ORIGIN                          the web origin for CORS (required)
 *   TRUST_PROXY                             '1': client IP from X-Forwarded-For
 *   BANK_TOKEN                              bearer token for the bank: ≥ 32 token68 chars (optional)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { isAddress } from '@solana/kit';
import { type JsonValue, canonicalize } from '@tio/sandbox-bank/jcs';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type Deployment = {
  oracleProgram: string;
  credential: string;
  schema: string;
  sasProgram: string;
};

export type Config = {
  enclaveUrl: string;
  bankUrl: string;
  rpcUrl: string;
  wsUrl: string;
  cluster: string;
  deployment: Deployment;
  measurementId: number;
  policy: unknown;
  /** Hex sha256 of the policy file bytes (the file is JCS, FORMATS §6). */
  policyHash: string;
  relayerSecret: Uint8Array;
  port: number;
  allowedOrigin: string;
  trustProxy: boolean;
  /** Sent as `authorization: Bearer …` on every bank call (FORMATS §15). */
  bankToken?: string;
};

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new ConfigError(`${name} is required`);
  return value;
}

function url(value: string, name: string, protocols: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a ${protocols.join(' or ')} URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new ConfigError(`${name} must be a ${protocols.join(' or ')} URL`);
  }
  return parsed;
}

function httpUrl(env: Env, name: string): string {
  const value = required(env, name);
  url(value, name, ['http:', 'https:']);
  return value;
}

function wsUrl(env: Env, rpcUrl: string): string {
  const value = env['SOLANA_WS_URL'];
  if (value === undefined) return deriveWsUrl(rpcUrl);
  url(value, 'SOLANA_WS_URL', ['ws:', 'wss:']);
  return value;
}

/** One exact web origin (scheme://host[:port]); never `*`, which would let any site call us. */
function allowedOrigin(env: Env): string {
  const value = required(env, 'ALLOWED_ORIGIN');
  if (url(value, 'ALLOWED_ORIGIN', ['http:', 'https:']).origin !== value) {
    throw new ConfigError('ALLOWED_ORIGIN must be an exact origin like https://app.example');
  }
  return value;
}

/** RFC 6750 token68, ≥ 32 chars; the bank's `BANK_TOKEN` rule is the same. */
const BANK_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,}$/;

function bankToken(env: Env): { bankToken?: string } {
  const value = env['BANK_TOKEN'];
  if (value === undefined) return {};
  if (!BANK_TOKEN_PATTERN.test(value)) {
    throw new ConfigError('BANK_TOKEN must be at least 32 characters of A-Z a-z 0-9 . _ ~ + / = -');
  }
  return { bankToken: value };
}

function integer(env: Env, name: string, min: number, max: number, fallback?: number): number {
  const raw = env[name];
  if ((raw === undefined || raw === '') && fallback !== undefined) return fallback;
  const value = required(env, name);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new ConfigError(`${name} must be an integer in ${min}..${max}`);
  }
  return Number(value);
}

/** ws(s) twin of an http(s) RPC URL; the local validator's default port 8899 maps to 8900. */
function deriveWsUrl(rpcUrl: string): string {
  const ws = new URL(rpcUrl);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  if (ws.port === '8899') ws.port = '8900';
  return ws.toString().replace(/\/$/, '');
}

const base58Address = z.string().refine(isAddress); // decodes to exactly 32 bytes
const deploymentSchema = z.object({
  oracle_program: base58Address,
  credential: base58Address,
  schema: base58Address,
  sas_program: base58Address,
});

function loadDeployment(cluster: string, repoRoot: string): Deployment {
  if (!/^[a-z0-9-]+$/.test(cluster)) throw new ConfigError('CLUSTER must be a cluster name');
  let parsed: z.infer<typeof deploymentSchema>;
  try {
    const text = readFileSync(join(repoRoot, 'deployments', `${cluster}.json`), 'utf8');
    parsed = deploymentSchema.parse(JSON.parse(text));
  } catch {
    throw new ConfigError('CLUSTER has no valid deployments/<cluster>.json');
  }
  return {
    oracleProgram: parsed.oracle_program,
    credential: parsed.credential,
    schema: parsed.schema,
    sasProgram: parsed.sas_program,
  };
}

function isJsonValue(v: unknown): v is JsonValue {
  if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return true;
  if (Array.isArray(v)) return v.every(isJsonValue);
  return typeof v === 'object' && Object.values(v).every(isJsonValue);
}

/** JCS text of `v`, or undefined when it can't be canonical (e.g. a float). */
function jcsOf(v: unknown): string | undefined {
  try {
    return isJsonValue(v) ? canonicalize(v) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The policy file must be exact JCS (FORMATS §6): the enclave hashes the JCS
 * of the policy it receives, so only then does `policy_hash` (sha256 of these
 * bytes, shown in /v1/info) equal the hash in the attestation.
 */
function loadPolicy(path: string, repoRoot: string): { policy: unknown; policyHash: string } {
  const full = isAbsolute(path) ? path : join(repoRoot, path);
  let text: string;
  let policy: unknown;
  try {
    text = readFileSync(full, 'utf8');
    policy = JSON.parse(text);
  } catch {
    throw new ConfigError('POLICY_PATH must name a readable JSON file');
  }
  if (jcsOf(policy) !== text) {
    throw new ConfigError('POLICY_PATH must be canonical JSON (JCS, no trailing newline)');
  }
  return { policy, policyHash: createHash('sha256').update(text, 'utf8').digest('hex') };
}

const keypairSchema = z.array(z.number().int().min(0).max(255)).length(64);

/** The relayer keypair; any error says only what is wrong, never the value. */
function relayerSecret(env: Env): Uint8Array {
  const raw = required(env, 'RELAYER_KEYPAIR');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('RELAYER_KEYPAIR must be a JSON array of 64 bytes');
  }
  const result = keypairSchema.safeParse(parsed);
  if (!result.success) throw new ConfigError('RELAYER_KEYPAIR must be a JSON array of 64 bytes');
  return Uint8Array.from(result.data);
}

export function loadConfig(env: Env, repoRoot: string): Config {
  const rpcUrl = httpUrl(env, 'SOLANA_RPC_URL');
  const cluster = required(env, 'CLUSTER');
  const policyPath = env['POLICY_PATH'] ?? 'test-vectors/policy/default.json';
  return {
    enclaveUrl: httpUrl(env, 'ENCLAVE_URL'),
    bankUrl: httpUrl(env, 'BANK_URL'),
    rpcUrl,
    wsUrl: wsUrl(env, rpcUrl),
    cluster,
    deployment: loadDeployment(cluster, repoRoot),
    measurementId: integer(env, 'MEASUREMENT_ID', 0, 254),
    ...loadPolicy(policyPath, repoRoot),
    relayerSecret: relayerSecret(env),
    port: integer(env, 'PORT', 1, 65_535, 8082),
    allowedOrigin: allowedOrigin(env),
    trustProxy: env['TRUST_PROXY'] === '1',
    ...bankToken(env),
  };
}
