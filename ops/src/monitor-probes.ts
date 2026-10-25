/**
 * The monitor's reads: each probe reports an error instead of throwing, so one
 * dead service never hides the others. Every call has a timeout, and a failed
 * probe is tried once more before it counts (public RPCs rate-limit shared
 * runner IPs). Read-only; no keys. Upstream text reaches a public issue, so
 * identifiers are checked against short patterns first.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { type Address, address, createSolanaRpc } from '@solana/kit';
import { b64Decode, toHex } from '@tio/encoding';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { ORACLE_PROGRAM_ID, parseEnclaveEntry } from '@tio/oracle-client/attest';
import { z } from 'zod';
import {
  type GatewayInfo,
  type OysterJob,
  type Probed,
  type Probes,
  decodeJob,
} from './monitor.ts';

/** Marlin's Oyster market on Arbitrum One (`oyster-cvm` 5.0.1 `configs/arb.rs`). */
export const OYSTER_MARKET = '0x9d95D61eA056721E358BC49fE995caBF3B86A34B';

const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 5_000;
/** Any valid key works: the session expires unused (FORMATS §16). The System Program's. */
const PROBE_WALLET = '11111111111111111111111111111111';

const EthAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const ErrorWord = z.string().regex(/^[a-z_]{1,40}$/);

export type Targets = {
  gatewayUrl: string;
  enclaveIp: string;
  oysterJobId: string;
  solanaRpcUrl: string;
  arbitrumRpcUrl: string;
  indexerUrl: string;
  /** Wait before the one retry; tests pass 0. */
  retryDelayMs?: number;
};

const timeout = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);

/** One line for a report: a schema error names its first issue, a network error its cause code. */
export function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const [issue] = error.issues;
    return issue === undefined
      ? 'unexpected answer'
      : `unexpected answer at ${issue.path.join('.') || '(root)'}: ${issue.message}`;
  }
  if (error instanceof Error) {
    const cause: unknown = error.cause;
    const code =
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      typeof cause.code === 'string'
        ? ` (${cause.code})`
        : '';
    return `${error.message}${code}`;
  }
  return String(error);
}

async function probe<T>(read: () => Promise<T>, retryDelayMs: number): Promise<Probed<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      return { ok: true, value: await read() };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }
}

const GatewayErrorSchema = z.object({ error: z.object({ code: ErrorWord, stage: ErrorWord }) });

/** The body of a 2xx answer as JSON; otherwise an error naming the status and any error code. */
async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: timeout() });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = GatewayErrorSchema.safeParse(body);
    const why = parsed.success ? `: ${parsed.data.error.code} (${parsed.data.error.stage})` : '';
    throw new Error(
      `${init?.method ?? 'GET'} ${new URL(url).pathname}: HTTP ${response.status}${why}`,
    );
  }
  return body;
}

const postJson = (url: string, payload: unknown): Promise<unknown> =>
  json(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

const InfoSchema = z.object({
  measurement_id: z.number().int().min(0).max(254),
  attester_address: EthAddress,
  relayer: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
});

async function gatewayInfo(gatewayUrl: string): Promise<GatewayInfo> {
  const info = InfoSchema.parse(await json(`${gatewayUrl}/v1/info`));
  return {
    measurementId: info.measurement_id,
    attester: info.attester_address,
    relayer: info.relayer,
  };
}

async function genesisHash(rpcUrl: string): Promise<string> {
  return createSolanaRpc(rpcUrl).getGenesisHash().send({ abortSignal: timeout() });
}

async function registryEntry(
  rpcUrl: string,
  measurementId: number,
): Promise<{ attester: string; revoked: boolean } | null> {
  const [at] = await findEnclaveEntryPda({ measurementId });
  const { value } = await createSolanaRpc(rpcUrl)
    .getAccountInfo(at, { encoding: 'base64' })
    .send({ abortSignal: timeout() });
  if (value === null || value.owner !== ORACLE_PROGRAM_ID) return null;
  const entry = parseEnclaveEntry(value.owner, b64Decode(value.data[0]));
  return {
    attester: `0x${toHex(Uint8Array.from(entry.attester))}`,
    revoked: entry.revokedAt !== 0n,
  };
}

async function lamports(rpcUrl: string, who: Address): Promise<bigint> {
  const { value } = await createSolanaRpc(rpcUrl).getBalance(who).send({ abortSignal: timeout() });
  return value;
}

const EthRpcSchema = z.union([
  z.object({ error: z.object({ message: z.string() }) }),
  z.object({ result: z.unknown() }),
]);

/** An Ethereum JSON-RPC call's `result`; an RPC error is thrown with its own message. */
async function ethRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const answer = EthRpcSchema.parse(await postJson(url, { jsonrpc: '2.0', id: 1, method, params }));
  if ('error' in answer) throw new Error(`${method}: ${answer.error.message}`);
  return answer.result;
}

const selector = (signature: string): string =>
  toHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8);

/** `eth_call` data for `jobs(bytes32)`: the selector and the job id left-padded to 32 bytes. */
export function jobsCalldata(jobId: string): string {
  return `0x${selector('jobs(bytes32)')}${jobId.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
}

async function oysterJob(arbitrumRpcUrl: string, jobId: string): Promise<OysterJob | null> {
  const data = jobsCalldata(jobId);
  const result = z
    .string()
    .regex(/^0x[0-9a-fA-F]*$/)
    .parse(await ethRpc(arbitrumRpcUrl, 'eth_call', [{ to: OYSTER_MARKET, data }, 'latest']));
  return decodeJob(result);
}

const SyncSchema = z.object({
  data: z.object({
    allSyncs: z.object({ nodes: z.array(z.object({ block: z.string().regex(/^\d+$/) })).min(1) }),
  }),
});

/** Age in seconds of the block Marlin's indexer reports it has synced to (`allSyncs`). */
async function indexerLag(indexerUrl: string, arbitrumRpcUrl: string): Promise<number> {
  const answer = SyncSchema.parse(
    await postJson(indexerUrl, { query: '{ allSyncs { nodes { block } } }' }),
  );
  const head = answer.data.allSyncs.nodes.reduce(
    (max, n) => (BigInt(n.block) > max ? BigInt(n.block) : max),
    0n,
  );
  const block = z
    .object({ timestamp: z.string().regex(/^0x[0-9a-fA-F]+$/) })
    .parse(await ethRpc(arbitrumRpcUrl, 'eth_getBlockByNumber', [`0x${head.toString(16)}`, false]));
  return Math.floor(Date.now() / 1000) - Number(BigInt(block.timestamp));
}

/** Runs every probe; those that need the gateway's /v1/info wait for it. */
export async function runProbes(t: Targets): Promise<Probes> {
  const delay = t.retryDelayMs ?? RETRY_DELAY_MS;
  const unavailable = { ok: false, error: 'gateway /v1/info unavailable' } as const;
  const [solanaGenesis, gatewayHealth, session, info, enclaveAttester, job, indexerLagSecs] =
    await Promise.all([
      probe(() => genesisHash(t.solanaRpcUrl), delay),
      probe(async () => {
        await json(`${t.gatewayUrl}/health`);
        return null;
      }, delay),
      probe(async () => {
        await postJson(`${t.gatewayUrl}/v1/sessions`, {
          wallet: PROBE_WALLET,
          persona_id: 'salaried_steady',
        });
        return null;
      }, delay),
      probe(() => gatewayInfo(t.gatewayUrl), delay),
      probe(
        async () =>
          z
            .object({ attester_address: EthAddress })
            .parse(await json(`http://${t.enclaveIp}:8080/v1/info`)).attester_address,
        delay,
      ),
      probe(() => oysterJob(t.arbitrumRpcUrl, t.oysterJobId), delay),
      probe(() => indexerLag(t.indexerUrl, t.arbitrumRpcUrl), delay),
    ]);
  const [registry, relayerLamports] = info.ok
    ? await Promise.all([
        probe(() => registryEntry(t.solanaRpcUrl, info.value.measurementId), delay),
        probe(() => lamports(t.solanaRpcUrl, address(info.value.relayer)), delay),
      ])
    : [unavailable, unavailable];
  return {
    solanaGenesis,
    gatewayHealth,
    session,
    gatewayInfo: info,
    enclaveAttester,
    registryEntry: registry,
    relayerLamports,
    oysterJob: job,
    indexerLagSecs,
  };
}
