import { b64Encode, fromHex } from '@tio/encoding';
import { getEnclaveEntryEncoder } from '@tio/oracle-client';
import { ORACLE_PROGRAM_ID } from '@tio/oracle-client/attest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEVNET_GENESIS_HASH } from './cluster.ts';
import { OYSTER_MARKET, describeError, jobsCalldata, runProbes } from './monitor-probes.ts';

const ATTESTER = '0x7588de07d659a583c8c82261ff3b95c0e039a7f3';
const RELAYER = '9jR2xmkX4ccCPkrH58NZPpLtSA29dQggXosyxhLFusDq';
const TARGETS = {
  gatewayUrl: 'https://gw.test',
  enclaveIp: '10.0.0.1',
  oysterJobId: '0x1a2b',
  solanaRpcUrl: 'https://sol.test/',
  arbitrumRpcUrl: 'https://arb.test/',
  indexerUrl: 'https://idx.test/graphql',
  retryDelayMs: 0,
};
// jobs() head of a live job: owner (a placeholder, never our wallet), provider,
// rate 0.084985 USDC/h, 1.084985 USDC, settled.
const JOB_HEAD =
  '0x' +
  [
    '00000000000000000000000000000000000000000000000000000000000000c0',
    `000000000000000000000000${'ab'.repeat(20)}`,
    '000000000000000000000000e10fa12f580e660ecd593ea4119cebc90509d642',
    '000000000000000000000000000000000000000000000000000015786e77eb85',
    '0000000000000000000000000000000000000000000000000000000000108e39',
    '000000000000000000000000000000000000000000000000000000006ad8d3b8',
  ].join('');

const RequestSchema = z
  .object({ id: z.unknown(), method: z.string(), params: z.array(z.unknown()).optional() })
  .nullable();

type Reply = Response | Error;
type Handler = (method: string, params: unknown[]) => Reply;
type Routes = Record<string, Handler>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const rpc = (id: unknown, result: unknown): Response => json({ jsonrpc: '2.0', id, result });

function entryBase64(): string {
  const bytes = getEnclaveEntryEncoder().encode({
    version: 1,
    bump: 255,
    measurementId: 2,
    measurementKind: 1,
    measurement: new Uint8Array(32).fill(7),
    attester: fromHex(ATTESTER.slice(2)),
    attestationDocHash: new Uint8Array(32),
    registeredAt: 1n,
    revokedAt: 0n,
  });
  return b64Encode(Uint8Array.from(bytes));
}

/** A healthy deployment, keyed by URL; a test overrides single routes. */
function healthyRoutes(calls: { url: string; method: string; params: unknown[] }[]): Routes {
  const now = Math.floor(Date.now() / 1000);
  return {
    'https://gw.test/health': () => json({ status: 'ok' }),
    'https://gw.test/v1/sessions': () => json({ session_id: 's', intent: 'i', intent_expires: 1 }),
    'https://gw.test/v1/info': () =>
      json({ cluster: 'devnet', measurement_id: 2, attester_address: ATTESTER, relayer: RELAYER }),
    'http://10.0.0.1:8080/v1/info': () =>
      json({ app_version: '0.1.0', attester_address: ATTESTER }),
    'https://idx.test/graphql': () => json({ data: { allSyncs: { nodes: [{ block: '100' }] } } }),
    'https://arb.test/': (method, params) => {
      calls.push({ url: 'arb', method, params });
      if (method === 'eth_call') return json({ jsonrpc: '2.0', id: 1, result: JOB_HEAD });
      return json({ jsonrpc: '2.0', id: 1, result: { timestamp: `0x${(now - 60).toString(16)}` } });
    },
    'https://sol.test/': (method) => {
      if (method === 'getGenesisHash') return new Response('GENESIS');
      if (method === 'getBalance') return new Response('BALANCE');
      return new Response('ACCOUNT');
    },
  };
}

/** Replaces fetch; Solana replies need the request id, so they are built here from the method. */
function stubFetch(routes: Routes): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const handler = routes[url];
      if (handler === undefined) throw new Error(`unexpected fetch ${url}`);
      const parsed = RequestSchema.safeParse(
        typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      );
      const request = parsed.success ? parsed.data : null;
      const reply = handler(request?.method ?? '', request?.params ?? []);
      if (reply instanceof Error) throw reply;
      if (url !== TARGETS.solanaRpcUrl) return reply;
      const kind = await reply.text();
      const id = request?.id;
      if (kind === 'GENESIS') return rpc(id, DEVNET_GENESIS_HASH);
      if (kind === 'BALANCE') return rpc(id, { context: { slot: 1 }, value: 5_000_000_000 });
      return rpc(id, {
        context: { slot: 1 },
        value: {
          data: [entryBase64(), 'base64'],
          executable: false,
          lamports: 1,
          owner: ORACLE_PROGRAM_ID,
          rentEpoch: 0,
          space: 0,
        },
      });
    }),
  );
}

// Handlers return a fresh Response per call: a body reads only once, and a failed probe retries.
const codedError = (): Response =>
  json({ error: { code: 'upstream_unavailable', stage: 'enclave' } }, 502);
const hostileError = (): Response =>
  json({ error: { code: 'x\n@someone [link](http://e)', stage: 'gateway' } }, 502);
const connectionReset = (): Error =>
  new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
const reverted = (): Response =>
  json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } });
const oddAttester = (): Response => json({ attester_address: 'not\nan address' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('jobsCalldata', () => {
  it('is_the_jobs_selector_and_the_left_padded_id', () => {
    expect(jobsCalldata('0x1A2B')).toBe(`0x38ed7cfc${'0'.repeat(60)}1a2b`);
  });
});

describe('runProbes', () => {
  it('reads_every_probe_from_a_healthy_deployment', async () => {
    const calls: { url: string; method: string; params: unknown[] }[] = [];
    stubFetch(healthyRoutes(calls));
    const probes = await runProbes(TARGETS);
    expect(probes).toMatchObject({
      solanaGenesis: { ok: true, value: DEVNET_GENESIS_HASH },
      gatewayHealth: { ok: true },
      session: { ok: true },
      gatewayInfo: { ok: true, value: { measurementId: 2, attester: ATTESTER, relayer: RELAYER } },
      enclaveAttester: { ok: true, value: ATTESTER },
      registryEntry: { ok: true, value: { attester: ATTESTER, revoked: false } },
      relayerLamports: { ok: true, value: 5_000_000_000n },
      oysterJob: { ok: true, value: { balance: 1_084_985n } },
    });
    expect(probes.indexerLagSecs.ok && probes.indexerLagSecs.value).toBeGreaterThanOrEqual(60);
    const ethCall = calls.find((c) => c.method === 'eth_call');
    expect(ethCall?.params[0]).toEqual({ to: OYSTER_MARKET, data: jobsCalldata('0x1a2b') });
    expect(calls.find((c) => c.method === 'eth_getBlockByNumber')?.params).toEqual(['0x64', false]);
  });

  it('marks_the_gateway_dependent_probes_unavailable_and_keeps_the_others', async () => {
    stubFetch({ ...healthyRoutes([]), 'https://gw.test/v1/info': () => json(null, 502) });
    const probes = await runProbes(TARGETS);
    expect(probes.gatewayInfo).toEqual({ ok: false, error: 'GET /v1/info: HTTP 502' });
    expect(probes.registryEntry).toEqual({ ok: false, error: 'gateway /v1/info unavailable' });
    expect(probes.relayerLamports).toEqual({ ok: false, error: 'gateway /v1/info unavailable' });
    expect(probes.enclaveAttester.ok && probes.oysterJob.ok && probes.session.ok).toBe(true);
  });

  it('names_the_gateway_error_code_but_never_echoes_an_unexpected_one', async () => {
    stubFetch({ ...healthyRoutes([]), 'https://gw.test/v1/sessions': codedError });
    expect((await runProbes(TARGETS)).session).toEqual({
      ok: false,
      error: 'POST /v1/sessions: HTTP 502: upstream_unavailable (enclave)',
    });
    stubFetch({ ...healthyRoutes([]), 'https://gw.test/v1/sessions': hostileError });
    expect((await runProbes(TARGETS)).session).toEqual({
      ok: false,
      error: 'POST /v1/sessions: HTTP 502',
    });
  });

  it('reports_a_network_error_with_its_cause_code', async () => {
    stubFetch({ ...healthyRoutes([]), 'http://10.0.0.1:8080/v1/info': connectionReset });
    const probes = await runProbes(TARGETS);
    expect(probes.enclaveAttester).toEqual({ ok: false, error: 'fetch failed (ECONNRESET)' });
    expect(probes.gatewayHealth.ok).toBe(true);
  });

  it('retries_a_failed_probe_once', async () => {
    let calls = 0;
    const flaky = () => {
      calls += 1;
      return calls === 1 ? json(null, 503) : json({ status: 'ok' });
    };
    stubFetch({ ...healthyRoutes([]), 'https://gw.test/health': flaky });
    expect((await runProbes(TARGETS)).gatewayHealth).toEqual({ ok: true, value: null });
    expect(calls).toBe(2);
  });

  it('passes_a_json_rpc_error_message_through', async () => {
    stubFetch({ ...healthyRoutes([]), 'https://arb.test/': reverted });
    const probes = await runProbes(TARGETS);
    expect(probes.oysterJob).toEqual({ ok: false, error: 'eth_call: execution reverted' });
  });

  it('rejects_an_attester_that_is_not_an_address', async () => {
    stubFetch({ ...healthyRoutes([]), 'http://10.0.0.1:8080/v1/info': oddAttester });
    const probe = (await runProbes(TARGETS)).enclaveAttester;
    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.error).toMatch(/^unexpected answer at attester_address: /);
  });
});

describe('describeError', () => {
  it('names_the_first_schema_issue_on_one_line', () => {
    const result = z.object({ a: z.number() }).safeParse({ a: 'x' });
    expect(result.success).toBe(false);
    const message = result.success ? '' : describeError(result.error);
    expect(message).toMatch(/^unexpected answer at a: /);
    expect(message).not.toContain('\n');
  });
});
