// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelay } from './relay.ts';
import { SIG } from '../test-support/fakes.ts';
import { bodyOf, jsonResponse, urlOf } from '../test-support/sse.ts';

const BASE = 'https://gateway.test';
const signal = () => new AbortController().signal;
type FetchFn = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

function stubFetch(handler: FetchFn) {
  const fetchMock = vi.fn<FetchFn>(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const errorBody = (code: string, detail?: unknown) => ({
  error: { code, message: 'm', stage: 'gateway', ...(detail === undefined ? {} : { detail }) },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay', () => {
  it('POSTs {tx_b64} to /v1/loans/relay and returns the signature', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ signature: SIG }));
    const result = await createRelay(BASE).relay('QUJD', signal());
    expect(result).toEqual({ ok: true, value: SIG });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(urlOf(url ?? '')).toBe(`${BASE}/v1/loans/relay`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(bodyOf(init))).toEqual({ tx_b64: 'QUJD' });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])(
    'surfaces bad_transaction rule %i as {rule}',
    async (rule) => {
      stubFetch(async () => jsonResponse(errorBody('bad_transaction', { rule }), 400));
      expect(await createRelay(BASE).relay('QUJD', signal())).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'bad_transaction', rule }) as unknown,
      });
    },
  );

  it('surfaces a program error of simulation_failed with its instruction index and code', async () => {
    stubFetch(async () =>
      jsonResponse(errorBody('simulation_failed', { index: 1, custom: 6008 }), 409),
    );
    expect(await createRelay(BASE).relay('QUJD', signal())).toMatchObject({
      ok: false,
      error: { code: 'simulation_failed', index: 1, custom: 6008 },
    });
  });

  it('surfaces a named simulation error with its kind', async () => {
    stubFetch(async () =>
      jsonResponse(errorBody('simulation_failed', { index: 0, kind: 'InsufficientFunds' }), 409),
    );
    expect(await createRelay(BASE).relay('QUJD', signal())).toMatchObject({
      ok: false,
      error: { code: 'simulation_failed', index: 0, kind: 'InsufficientFunds' },
    });
    stubFetch(async () => jsonResponse(errorBody('simulation_failed', { kind: 'unknown' }), 409));
    expect(await createRelay(BASE).relay('QUJD', signal())).toMatchObject({
      ok: false,
      error: { code: 'simulation_failed', kind: 'unknown' },
    });
  });

  it.each([
    ['relay_in_flight', 429],
    ['sponsorship_exhausted', 429],
    ['tx_failed', 502],
    ['rate_limited', 429],
  ])('surfaces %s by its code', async (code, status) => {
    stubFetch(async () => jsonResponse(errorBody(code), status));
    expect(await createRelay(BASE).relay('QUJD', signal())).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it('is a protocol_error when bad_transaction has no usable detail', async () => {
    stubFetch(async () => jsonResponse(errorBody('bad_transaction'), 400));
    expect(await createRelay(BASE).relay('QUJD', signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });

  it('is a protocol_error for a signature that is not base58 of 64 bytes', async () => {
    stubFetch(async () => jsonResponse({ signature: 'not-a-signature' }));
    expect(await createRelay(BASE).relay('QUJD', signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });

  it('is a protocol_error for a 200 reply without a signature', async () => {
    stubFetch(async () => jsonResponse({ nope: true }));
    expect(await createRelay(BASE).relay('QUJD', signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });

  it('is a network error when fetch rejects and cancelled on abort', async () => {
    stubFetch(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await createRelay(BASE).relay('QUJD', signal())).toMatchObject({
      ok: false,
      error: { code: 'network' },
    });
    const controller = new AbortController();
    controller.abort();
    stubFetch(async () => Promise.reject(new DOMException('aborted', 'AbortError')));
    expect(await createRelay(BASE).relay('QUJD', controller.signal)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });
});
