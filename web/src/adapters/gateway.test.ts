// @vitest-environment node
import { getBase58Decoder } from '@solana/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.ts';
import type { FlowEvent } from '../domain/types.ts';
import {
  bodyOf,
  collect,
  hangingSseResponse,
  jsonResponse,
  sseEvent,
  sseResponse,
  urlOf,
} from '../test-support/sse.ts';
import { ADMIN, POOL_0, RELAYER, CREDENTIAL, SCHEMA, OTHER } from '../test-support/fixtures.ts';

const BASE = 'https://gateway.test';
const SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PAYLOAD_HEX =
  '01010081112a23f4ee2835f6459b1f25d9159566204bc2e3e4d318b3ac73d526932e1cfa007acefc7ed7fe390e57095b786eb7d762054fb92e973f3699e6db573b942da097b76a0000000080d7d568000bb76a';
/** A well-formed base58 64-byte transaction signature. */
const TX = getBase58Decoder().decode(new Uint8Array(64).fill(9));
const RESULT_DATA = {
  tier: 'A',
  tx: TX,
  attestation: POOL_0,
  expiry: 1_790_000_600,
  payload_hex: PAYLOAD_HEX,
};
const signal = () => new AbortController().signal;

type FetchFn = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

function stubFetch(handler: FetchFn) {
  const fetchMock = vi.fn<FetchFn>(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSession', () => {
  it('POSTs {wallet, persona_id} and maps the reply', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ session_id: SESSION, intent: 'the intent', intent_expires: 1_790_000_600 }),
    );
    const result = await createGateway(BASE).createSession(ADMIN, 'trader_lumpy', signal());
    expect(result).toEqual({
      ok: true,
      value: { sessionId: SESSION, intent: 'the intent', intentExpires: 1_790_000_600n },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(urlOf(url ?? '')).toBe(`${BASE}/v1/sessions`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(bodyOf(init))).toEqual({ wallet: ADMIN, persona_id: 'trader_lumpy' });
  });

  it('maps a gateway error body to a typed error', async () => {
    stubFetch(async () =>
      jsonResponse(
        { error: { code: 'rate_limited', message: 'slow down', stage: 'gateway' } },
        429,
      ),
    );
    const result = await createGateway(BASE).createSession(ADMIN, 'declining', signal());
    expect(result).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
  });

  it('keeps an enclave or bank code it does not know as an upstream error with its stage', async () => {
    stubFetch(async () =>
      jsonResponse(
        { error: { code: 'bad_consent_signature', message: 'x', stage: 'enclave' } },
        400,
      ),
    );
    const result = await createGateway(BASE).createSession(ADMIN, 'declining', signal());
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'upstream_error', upstreamCode: 'bad_consent_signature', stage: 'enclave' },
    });
  });

  it.each([
    ['a code with spaces', { code: 'bad code', message: 'm', stage: 'enclave' }],
    ['an unknown stage', { code: 'bad_consent_signature', message: 'm', stage: 'browser' }],
  ])('is a protocol_error for an error body with %s', async (_, error) => {
    stubFetch(async () => jsonResponse({ error }, 400));
    const result = await createGateway(BASE).createSession(ADMIN, 'declining', signal());
    expect(result).toMatchObject({ ok: false, error: { code: 'protocol_error' } });
  });

  it('is a network error when fetch rejects', async () => {
    stubFetch(async () => Promise.reject(new TypeError('Failed to fetch')));
    const result = await createGateway(BASE).createSession(ADMIN, 'declining', signal());
    expect(result).toMatchObject({ ok: false, error: { code: 'network' } });
  });

  it('is cancelled when the signal aborts', async () => {
    const controller = new AbortController();
    stubFetch(async () => Promise.reject(new DOMException('aborted', 'AbortError')));
    controller.abort();
    const result = await createGateway(BASE).createSession(ADMIN, 'declining', controller.signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });

  it.each([
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['a missing member', () => jsonResponse({ session_id: 'x', intent: 'y' })],
    ['a wrong type', () => jsonResponse({ session_id: 1, intent: 'y', intent_expires: 5 })],
    [
      'a session id that is not a UUIDv4',
      () => jsonResponse({ session_id: 'x\nwallet: evil', intent: 'y', intent_expires: 5 }),
    ],
  ])('is a protocol_error for a reply that is %s, never a throw', async (_, respond) => {
    stubFetch(async () => respond());
    const result = await createGateway(BASE).createSession(ADMIN, 'declining', signal());
    expect(result).toMatchObject({ ok: false, error: { code: 'protocol_error' } });
  });
});

describe('info and health', () => {
  it('maps /v1/info to camelCase', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({
        cluster: 'devnet',
        oracle_program: OTHER,
        credential: CREDENTIAL,
        schema: SCHEMA,
        measurement_id: 1,
        policy_hash: '11'.repeat(32),
        attester_address: `0x${'c3'.repeat(20)}`,
        relayer: RELAYER,
      }),
    );
    const result = await createGateway(BASE).info(signal());
    expect(result).toEqual({
      ok: true,
      value: {
        cluster: 'devnet',
        oracleProgram: OTHER,
        credential: CREDENTIAL,
        schema: SCHEMA,
        measurementId: 1,
        policyHash: '11'.repeat(32),
        attesterAddress: `0x${'c3'.repeat(20)}`,
        relayer: RELAYER,
      },
    });
    expect(urlOf(fetchMock.mock.calls[0]?.[0] ?? '')).toBe(`${BASE}/v1/info`);
  });

  it('is a protocol_error when /v1/info has the wrong shape', async () => {
    stubFetch(async () => jsonResponse({ cluster: 'devnet' }));
    expect(await createGateway(BASE).info(signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });

  it('health is ok for {status: "ok"} and a failure otherwise', async () => {
    stubFetch(async () => jsonResponse({ status: 'ok' }));
    expect(await createGateway(BASE).health(signal())).toEqual({ ok: true, value: true });
    stubFetch(async () =>
      jsonResponse({ error: { code: 'internal_error', message: 'm', stage: 'gateway' } }, 500),
    );
    expect(await createGateway(BASE).health(signal())).toMatchObject({ ok: false });
  });
});

const stage = (name: string) => sseEvent('stage', { stage: name });

describe('completeSession', () => {
  it('POSTs {signature_b58} to the session complete route', async () => {
    const fetchMock = stubFetch(async () => sseResponse([stage('bind')]));
    await collect(createGateway(BASE).completeSession('sess-9', '5igSig', signal()));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(urlOf(url ?? '')).toBe(`${BASE}/v1/sessions/sess-9/complete`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(bodyOf(init))).toEqual({ signature_b58: '5igSig' });
  });

  it('yields every stage in order and then the result, with typed fields', async () => {
    stubFetch(async () =>
      sseResponse([
        ...['bind', 'fi_request', 'fi_fetch', 'evaluate', 'submit'].map(stage),
        sseEvent('result', RESULT_DATA),
      ]),
    );
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events).toEqual<FlowEvent[]>([
      { kind: 'stage', stage: 'bind' },
      { kind: 'stage', stage: 'fi_request' },
      { kind: 'stage', stage: 'fi_fetch' },
      { kind: 'stage', stage: 'evaluate' },
      { kind: 'stage', stage: 'submit' },
      {
        kind: 'result',
        result: {
          tier: 'A',
          tx: TX,
          attestation: POOL_0,
          expiry: 1_790_000_600n,
          payloadHex: PAYLOAD_HEX,
        },
      },
    ]);
  });

  it('accepts tx: null (the attestation already held this payload)', async () => {
    stubFetch(async () => sseResponse([sseEvent('result', { ...RESULT_DATA, tx: null })]));
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events).toMatchObject([{ kind: 'result', result: { tier: 'A', tx: null } }]);
  });

  it('yields a REJECT result', async () => {
    stubFetch(async () => sseResponse([stage('bind'), sseEvent('result', { tier: 'REJECT' })]));
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events.at(-1)).toEqual({ kind: 'result', result: { tier: 'REJECT' } });
  });

  it('reassembles chunks split inside the event name, the data and the line break', async () => {
    stubFetch(async () =>
      sseResponse([
        'event: sta',
        'ge\ndata: {"stage":"bind"}',
        '\n',
        '\nevent: stage\ndata: {"sta',
        'ge":"submit"}\n\n',
        'event: result\ndata: {"tier":"RE',
        'JECT"}\n\n',
      ]),
    );
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events).toEqual([
      { kind: 'stage', stage: 'bind' },
      { kind: 'stage', stage: 'submit' },
      { kind: 'result', result: { tier: 'REJECT' } },
    ]);
  });

  it('handles CRLF line endings, including a split between CR and LF', async () => {
    stubFetch(async () =>
      sseResponse([
        'event: stage\r',
        '\ndata: {"stage":"bind"}\r\n\r',
        '\nevent: result\r\ndata: {"tier":"REJECT"}\r\n\r\n',
      ]),
    );
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events).toEqual([
      { kind: 'stage', stage: 'bind' },
      { kind: 'result', result: { tier: 'REJECT' } },
    ]);
  });

  it('ignores keep-alive comments', async () => {
    stubFetch(async () =>
      sseResponse([
        ': keep-alive\n\n',
        stage('bind'),
        ': keep-alive\n\n',
        sseEvent('result', { tier: 'REJECT' }),
      ]),
    );
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events).toEqual([
      { kind: 'stage', stage: 'bind' },
      { kind: 'result', result: { tier: 'REJECT' } },
    ]);
  });

  it('turns an error event into a typed error and stops, ignoring anything after it', async () => {
    stubFetch(async () =>
      sseResponse([
        stage('bind'),
        sseEvent('error', { code: 'stale_attestation', message: 'm', stage: 'chain' }),
        stage('submit'),
        sseEvent('result', RESULT_DATA),
      ]),
    );
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events).toEqual([
      { kind: 'stage', stage: 'bind' },
      { kind: 'error', error: expect.objectContaining({ code: 'stale_attestation' }) as unknown },
    ]);
  });

  it('is a protocol_error when the stream ends without a result or an error', async () => {
    stubFetch(async () => sseResponse([stage('bind'), stage('fi_request')]));
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ kind: 'error', error: { code: 'protocol_error' } });
  });

  it.each([
    ['an unknown stage name', [sseEvent('stage', { stage: 'hack' })]],
    ['data that is not JSON', ['event: stage\ndata: {nope\n\n']],
    ['an unknown event type', [sseEvent('mystery', { a: 1 })]],
    ['a result with the wrong shape', [sseEvent('result', { tier: 'Z' })]],
    ['a result whose tx is not a signature', [sseEvent('result', { ...RESULT_DATA, tx: 'sig-1' })]],
    [
      'a result with a negative-style payload',
      [sseEvent('result', { ...RESULT_DATA, expiry: 'soon' })],
    ],
  ])('is a protocol_error for %s, never a throw', async (_, chunks) => {
    stubFetch(async () => sseResponse(chunks));
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events.at(-1)).toMatchObject({ kind: 'error', error: { code: 'protocol_error' } });
    expect(events.filter((e) => e.kind === 'result')).toHaveLength(0);
  });

  it('is a protocol_error when one event exceeds the 64 KiB buffer', async () => {
    stubFetch(async () => sseResponse([`event: stage\ndata: ${'x'.repeat(70_000)}`, '\n\n']));
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events.at(-1)).toMatchObject({ kind: 'error', error: { code: 'protocol_error' } });
  });

  it('yields the JSON error of a non-200 reply before the stream starts, then ends', async () => {
    stubFetch(async () =>
      jsonResponse({ error: { code: 'session_expired', message: 'm', stage: 'gateway' } }, 410),
    );
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events).toEqual([
      { kind: 'error', error: expect.objectContaining({ code: 'session_expired' }) as unknown },
    ]);
  });

  it('is a protocol_error for a non-200 reply that is not the JSON error shape', async () => {
    stubFetch(async () => new Response('Bad Gateway', { status: 502 }));
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', error: { code: 'protocol_error' } });
  });

  it('is a network error when fetch itself rejects', async () => {
    stubFetch(async () => Promise.reject(new TypeError('Failed to fetch')));
    const events = await collect(createGateway(BASE).completeSession('s', 'sig', signal()));
    expect(events).toEqual([
      { kind: 'error', error: expect.objectContaining({ code: 'network' }) as unknown },
    ]);
  });

  it('yields cancelled and ends when the signal aborts mid-stream', async () => {
    const controller = new AbortController();
    stubFetch(async (_, init) => hangingSseResponse(stage('bind'), init?.signal));
    const stream = createGateway(BASE).completeSession('s', 'sig', controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { kind: 'stage', stage: 'bind' } });
    controller.abort();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { kind: 'error', error: expect.objectContaining({ code: 'cancelled' }) as unknown },
    });
    expect((await iterator.next()).done).toBe(true);
  });
});
