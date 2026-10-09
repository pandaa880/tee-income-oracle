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
 *   BANK_TOKEN                              bearer token for the bank: ≥ 32 b64token chars (optional);
 *                                           with it, BANK_URL must be https or a private http host
 */
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { isAddress } from '@solana/kit';
import { DEMO_POOL_PROGRAM_ADDRESS } from '@tio/demo-pool-client';
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
  /** The demo pools' token; absent until `pool:setup` ran on the cluster. */
  mint?: string;
  /** Demo pool addresses in file order; the loan relay serves only these. */
  pools: readonly string[];
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

/** RFC 6750 b64token (`=` only as trailing padding), ≥ 32 chars; the bank's rule is the same. */
const BANK_TOKEN_PATTERN = /^(?=.{32,}$)[A-Za-z0-9._~+/-]+=*$/;

function bankToken(env: Env): { bankToken?: string } {
  const value = env['BANK_TOKEN'];
  if (value === undefined) return {};
  if (!BANK_TOKEN_PATTERN.test(value)) {
    throw new ConfigError(
      'BANK_TOKEN must be at least 32 characters of A-Z a-z 0-9 . _ ~ + / -, then optional trailing =',
    );
  }
  return { bankToken: value };
}

/** Hosts where plain http stays on the machine or a private network. */
function isPrivateHost(hostname: string): boolean {
  // URL keeps IPv6 bracketed: only loopback counts (no dots, so test it first).
  if (hostname.startsWith('[')) return hostname === '[::1]';
  if (isIPv4(hostname)) {
    const [a = -1, b = -1] = hostname.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return (
    hostname === 'localhost' ||
    !hostname.includes('.') || // single-label service name (`bank`)
    hostname.endsWith('.internal') // ICANN-reserved private TLD
  );
}

/** RFC 6750: a bearer token needs a confidential channel, so only https or a private hop. */
function bankUrl(env: Env, token: string | undefined): string {
  const value = httpUrl(env, 'BANK_URL');
  const parsed = new URL(value);
  if (token !== undefined && parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname)) {
    throw new ConfigError(
      'BANK_URL must be https (or http to localhost, a private IPv4, a single-label or .internal name) when BANK_TOKEN is set',
    );
  }
  return value;
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
  mint: base58Address.optional(),
  demo_pool_program: base58Address.optional(),
  pools: z
    .array(z.object({ address: base58Address, pool_id: z.int().min(0).max(255) }))
    .default([]),
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
  // The relay checks instructions against the compiled-in client: another program id would
  // mean the deployment file and this build disagree about what a borrow is.
  if (
    parsed.demo_pool_program !== undefined &&
    parsed.demo_pool_program !== DEMO_POOL_PROGRAM_ADDRESS
  ) {
    throw new ConfigError(
      "deployments/<cluster>.json demo_pool_program is not this build's demo-pool program",
    );
  }
  return {
    oracleProgram: parsed.oracle_program,
    credential: parsed.credential,
    schema: parsed.schema,
    sasProgram: parsed.sas_program,
    ...(parsed.mint === undefined ? {} : { mint: parsed.mint }),
    pools: parsed.pools.map((p) => p.address),
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
  const token = bankToken(env);
  return {
    enclaveUrl: httpUrl(env, 'ENCLAVE_URL'),
    bankUrl: bankUrl(env, token.bankToken),
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
    ...token,
  };
}
