/**
 * The gateway through its HTTP surface (`app.request`, no port): fake enclave/bank/relayer,
 * the real session store, an injected clock and a fake rate limiter.
 */
import { describe, expect, it } from 'vitest';

import { createApp } from './app.ts';
import { gatewayError } from './errors.ts';
import { SENT_SIGNATURE, fakeLoanRelay, type FakeLoanRelay } from './testing/fake-relay.ts';
import {
  SESSION_ID,
  SUBMITTED,
  TIER_RESULT,
  WALLET,
  fakeWorld,
  type Overrides,
} from './testing/fakes.ts';
import { parseSse, stageNames } from './testing/sse.ts';

const ORIGIN = 'https://app.example';
const INFO = {
  cluster: 'localnet',
  oracle_program: 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8',
  credential: 'F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7',
  schema: '991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV',
  measurement_id: 0,
  policy_hash: '81112a23f4ee2835f6459b1f25d9159566204bc2e3e4d318b3ac73d526932e1c',
  attester_address: '0x' + 'bb'.repeat(20),
  relayer: '3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND',
};
const CREATE_BODY = { wallet: WALLET, persona_id: 'salaried_steady' };
const ALL_STAGES = ['bind', 'fi_request', 'fi_fetch', 'evaluate', 'submit'];

type SetupOpts = {
  over?: Overrides;
  allow?: boolean;
  trustProxy?: boolean;
  fixedIp?: boolean;
  loanRelay?: FakeLoanRelay;
};

function setup(opts: SetupOpts = {}) {
  const w = fakeWorld(opts.over);
  const ips: string[] = [];
  const limiter = { allowed: opts.allow ?? true, ips };
  const loanRelay = opts.loanRelay ?? fakeLoanRelay();
  const app = createApp({
    ...w.deps,
    loanRelay,
    rateLimiter: {
      allow: (ip: string) => {
        limiter.ips.push(ip);
        return limiter.allowed;
      },
    },
    config: { allowedOrigin: ORIGIN, trustProxy: opts.trustProxy ?? false, info: INFO },
    ...(opts.fixedIp === false ? {} : { clientIp: () => '203.0.113.7' }),
  });
  return { app, w, limiter, loanRelay };
}

type Setup = ReturnType<typeof setup>;

function post(s: Setup, path: string, body: unknown, headers: Record<string, string> = {}) {
  return s.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await res.json();
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
  return Object.fromEntries(Object.entries(parsed));
}

async function errorOf(
  res: Response,
): Promise<{ code: unknown; stage: unknown; message: unknown }> {
  const body = await json(res);
  const error = body['error'];
  if (typeof error !== 'object' || error === null) throw new Error('no error member');
  return {
    code: Reflect.get(error, 'code'),
    stage: Reflect.get(error, 'stage'),
    message: Reflect.get(error, 'message'),
  };
}

async function openSession(s: Setup): Promise<string> {
  const res = await post(s, '/v1/sessions', CREATE_BODY);
  expect(res.status).toBe(200);
  return String((await json(res))['session_id']);
}

const complete = (s: Setup, id: string, body: unknown = { signature_b58: 'sigSig' }) =>
  post(s, `/v1/sessions/${id}/complete`, body);

describe('GET /health and /v1/info', () => {
  it('health returns { status: ok }', async () => {
    const res = await setup().app.request('/health');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: 'ok' });
  });

  it('info returns the configured deployment facts', async () => {
    const res = await setup().app.request('/v1/info');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual(INFO);
  });

  it('answers an unknown route with 404 { error: { code: not_found, stage: gateway } }', async () => {
    const res = await setup().app.request('/v1/nope');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: 'not_found', stage: 'gateway' });
  });
});

describe('CORS', () => {
  it('sets access-control-allow-origin to the configured origin', async () => {
    const res = await setup().app.request('/v1/info', { headers: { origin: ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('answers a preflight for POST /v1/sessions with that origin and content-type allowed', async () => {
    const res = await setup().app.request('/v1/sessions', {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain(
      'content-type',
    );
  });

  it('sets the header on error replies too', async () => {
    const res = await post(setup(), '/v1/sessions', 'not json', { origin: ORIGIN });
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});

describe('POST /v1/sessions', () => {
  it('returns session_id, intent and intent_expires as JSON', async () => {
    const res = await post(setup(), '/v1/sessions', CREATE_BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await json(res);
    expect(Object.keys(body).toSorted()).toEqual(['intent', 'intent_expires', 'session_id']);
    expect(body['session_id']).toBe(SESSION_ID);
  });

  it.each(['salaried_steady', 'trader_lumpy', 'declining', 'stressed'])(
    'accepts persona %s',
    async (persona_id) => {
      const s = setup();
      const res = await post(s, '/v1/sessions', { wallet: WALLET, persona_id });
      expect(res.status).toBe(200);
      expect(s.w.args.consent).toEqual([persona_id]);
    },
  );

  it.each([
    ['missing wallet', { persona_id: 'declining' }],
    ['missing persona', { wallet: WALLET }],
    ['unknown persona', { wallet: WALLET, persona_id: 'rich' }],
    ['unknown member', { ...CREATE_BODY, extra: 1 }],
    ['wallet over 44 chars', { ...CREATE_BODY, wallet: 'a'.repeat(45) }],
    ['non-string wallet', { ...CREATE_BODY, wallet: 5 }],
    ['wallet not base58', { ...CREATE_BODY, wallet: '0OIl'.repeat(10) }],
    ['array body', [CREATE_BODY]],
    ['JSON null', null],
  ])('rejects %s with 400 bad_request and calls nothing upstream', async (_name, body) => {
    const s = setup();
    const res = await post(s, '/v1/sessions', body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: 'bad_request', stage: 'gateway' });
    expect(s.w.log).toEqual([]);
  });

  it('rejects a body that is not JSON with 400 bad_request', async () => {
    const res = await post(setup(), '/v1/sessions', '{"wallet":');
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: 'bad_request', stage: 'gateway' });
  });

  it('rejects a body over 4 KiB with 413 body_too_large', async () => {
    const s = setup();
    const res = await post(
      s,
      '/v1/sessions',
      JSON.stringify({ ...CREATE_BODY, pad: 'x'.repeat(5000) }),
    );
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: 'body_too_large', stage: 'gateway' });
    expect(s.w.log).toEqual([]);
  });

  it('answers 429 rate_limited before any body work (even for an invalid body)', async () => {
    const s = setup({ allow: false });
    const res = await post(s, '/v1/sessions', 'not json at all');
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatchObject({ code: 'rate_limited', stage: 'gateway' });
    expect(s.w.log).toEqual([]);
  });

  it('asks the limiter once per create, with the client ip', async () => {
    const s = setup();
    await post(s, '/v1/sessions', CREATE_BODY);
    expect(s.limiter.ips).toEqual(['203.0.113.7']);
  });

  it('does not rate-limit complete, info or health', async () => {
    const s = setup({ allow: true });
    const id = await openSession(s);
    s.limiter.ips.length = 0;
    await complete(s, id);
    await s.app.request('/v1/info');
    await s.app.request('/health');
    expect(s.limiter.ips).toEqual([]);
  });

  it('passes an upstream failure through with its code, stage and status and a fixed message', async () => {
    const s = setup({
      over: {
        bank: {
          consent: async () => {
            throw gatewayError('Unauthorized', 'bank', 401);
          },
        },
      },
    });
    const res = await post(s, '/v1/sessions', CREATE_BODY);
    expect(res.status).toBe(401);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: 'Unauthorized', stage: 'bank' });
    expect(typeof error.message).toBe('string');
  });

  it('answers enclave_rotated with 503', async () => {
    const s = setup({
      over: {
        fiuKey: {
          ensureFresh: async () => {
            throw gatewayError('enclave_rotated', 'enclave', 503);
          },
        },
      },
    });
    const res = await post(s, '/v1/sessions', CREATE_BODY);
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({ code: 'enclave_rotated', stage: 'enclave' });
  });

  it('answers an unexpected exception with 500 internal_error and no detail', async () => {
    const s = setup({
      over: {
        bank: {
          consent: async () => {
            throw new Error('db password hunter2');
          },
        },
      },
    });
    const res = await post(s, '/v1/sessions', CREATE_BODY);
    expect(res.status).toBe(500);
    const text = JSON.stringify(await json(res));
    expect(text).toContain('internal_error');
    expect(text).not.toContain('hunter2');
  });
});

describe('client IP for the rate limiter', () => {
  it('uses the last X-Forwarded-For hop (the one the trusted proxy appended) when trustProxy is on', async () => {
    const s = setup({ trustProxy: true, fixedIp: false });
    await post(s, '/v1/sessions', CREATE_BODY, { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' });
    expect(s.limiter.ips).toEqual(['10.0.0.1']);
  });

  it('ignores X-Forwarded-For when trustProxy is off', async () => {
    const s = setup({ trustProxy: false, fixedIp: false });
    const res = await post(s, '/v1/sessions', CREATE_BODY, { 'x-forwarded-for': '9.9.9.9' });
    expect(res.status).toBe(200);
    expect(s.limiter.ips).toHaveLength(1);
    expect(s.limiter.ips[0]).not.toBe('9.9.9.9');
  });
});

describe('POST /v1/sessions/:id/complete: pre-stream JSON errors', () => {
  it('404 session_not_found for an unknown id', async () => {
    const res = await complete(setup(), 'no-such-id');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await errorOf(res)).toMatchObject({ code: 'session_not_found', stage: 'gateway' });
  });

  it('410 session_expired for an expired session', async () => {
    const s = setup();
    const id = await openSession(s);
    s.w.clock.t += 601;
    const res = await complete(s, id);
    expect(res.status).toBe(410);
    expect(await errorOf(res)).toMatchObject({ code: 'session_expired', stage: 'gateway' });
  });

  it('404 on the second complete of the same session (single use)', async () => {
    const s = setup();
    const id = await openSession(s);
    expect((await complete(s, id)).status).toBe(200);
    const again = await complete(s, id);
    expect(again.status).toBe(404);
    expect(await errorOf(again)).toMatchObject({ code: 'session_not_found' });
  });

  it.each([
    ['missing signature_b58', {}],
    ['unknown member', { signature_b58: 'sig', extra: true }],
    ['signature over 88 chars', { signature_b58: 'a'.repeat(89) }],
    ['non-string signature', { signature_b58: 7 }],
  ])('400 bad_request for %s', async (_name, body) => {
    const s = setup();
    const id = await openSession(s);
    const res = await complete(s, id, body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: 'bad_request', stage: 'gateway' });
    expect(s.w.args.enclaveBind).toEqual([]);
  });

  it('400 bad_request for a body that is not JSON', async () => {
    const s = setup();
    const id = await openSession(s);
    const res = await complete(s, id, 'nope');
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: 'bad_request' });
  });

  it('413 body_too_large for a body over 4 KiB', async () => {
    const s = setup();
    const id = await openSession(s);
    const res = await complete(s, id, { signature_b58: 'a'.repeat(5000) });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: 'body_too_large', stage: 'gateway' });
  });
});

async function run(over: Overrides = {}) {
  const s = setup({ over });
  const id = await openSession(s);
  const res = await complete(s, id);
  const text = await res.text();
  return { s, res, events: parseSse(text), text };
}

describe('POST /v1/sessions/:id/complete: SSE stream', () => {
  it('answers 200 text/event-stream', async () => {
    const { res } = await run();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('emits the five stages in order and then one result event for a tier', async () => {
    const { events } = await run();
    expect(stageNames(events)).toEqual(ALL_STAGES);
    expect(events.map((e) => e.event)).toEqual([
      'stage',
      'stage',
      'stage',
      'stage',
      'stage',
      'result',
    ]);
  });

  it('puts tier, tx, attestation, expiry and payload_hex in the result data', async () => {
    const { events } = await run();
    expect(events.at(-1)).toEqual({
      event: 'result',
      data: {
        tier: 'A',
        tx: SUBMITTED.tx,
        attestation: SUBMITTED.attestation,
        expiry: TIER_RESULT.expiry,
        payload_hex: TIER_RESULT.payload_hex,
      },
    });
  });

  it('stops after evaluate for REJECT with result { tier: REJECT }', async () => {
    const { events, s } = await run({ evaluate: { tier: 'REJECT' } });
    expect(stageNames(events)).toEqual(['bind', 'fi_request', 'fi_fetch', 'evaluate']);
    expect(events.at(-1)).toEqual({ event: 'result', data: { tier: 'REJECT' } });
    expect(s.w.args.submit).toEqual([]);
  });

  it('ends with an error event (code, stage, fixed message) when evaluate fails', async () => {
    const { events, res } = await run({
      enclave: {
        evaluate: async () => {
          throw gatewayError('bad_aa_signature', 'enclave', 422);
        },
      },
    });
    expect(res.status).toBe(200);
    expect(stageNames(events)).toEqual(['bind', 'fi_request', 'fi_fetch', 'evaluate']);
    const last = events.at(-1);
    expect(last?.event).toBe('error');
    expect(last?.data).toMatchObject({ code: 'bad_aa_signature', stage: 'enclave' });
    expect(typeof Reflect.get(Object(last?.data), 'message')).toBe('string');
    expect(events.filter((e) => e.event === 'result')).toEqual([]);
  });

  it('reports a chain failure after the submit stage', async () => {
    const { events } = await run({
      relayer: {
        submit: async () => {
          throw gatewayError('stale_attestation', 'chain', 409);
        },
      },
    });
    expect(stageNames(events)).toEqual(ALL_STAGES);
    expect(events.at(-1)).toMatchObject({
      event: 'error',
      data: { code: 'stale_attestation', stage: 'chain' },
    });
  });

  it('reports a bank failure with stage bank', async () => {
    const { events } = await run({
      bank: {
        fiFetch: async () => {
          throw gatewayError('DataGone', 'bank', 410);
        },
      },
    });
    expect(events.at(-1)).toMatchObject({
      event: 'error',
      data: { code: 'DataGone', stage: 'bank' },
    });
  });

  it('turns an unexpected exception into internal_error without detail', async () => {
    const { events, text } = await run({
      relayer: {
        submit: async () => {
          throw new Error('rpc url http://secret.internal');
        },
      },
    });
    expect(events.at(-1)).toMatchObject({
      event: 'error',
      data: { code: 'internal_error', stage: 'gateway' },
    });
    expect(text).not.toContain('secret.internal');
  });

  it('never repeats upstream message text in an error event', async () => {
    const failure = gatewayError('bad_aa_signature', 'enclave', 422);
    failure.message = 'upstream said: my-secret-detail';
    const { text } = await run({
      enclave: {
        evaluate: async () => {
          throw failure;
        },
      },
    });
    expect(text).not.toContain('my-secret-detail');
  });
});

describe('POST /v1/loans/relay', () => {
  const TX_B64 = Buffer.from('a transaction, as far as the route cares').toString('base64');

  it('GET /v1/info includes the relayer address', async () => {
    const res = await setup().app.request('/v1/info');
    expect((await json(res))['relayer']).toBe(INFO.relayer);
  });

  it('passes tx_b64 to the relay and answers 200 { signature }', async () => {
    const s = setup();
    const res = await post(s, '/v1/loans/relay', { tx_b64: TX_B64 });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ signature: SENT_SIGNATURE });
    expect(s.loanRelay.calls).toEqual([{ tx_b64: TX_B64 }]);
  });

  it('answers 429 rate_limited before any body work (even for an invalid body)', async () => {
    const s = setup({ allow: false });
    const res = await post(s, '/v1/loans/relay', 'not json at all');
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatchObject({ code: 'rate_limited', stage: 'gateway' });
    expect(s.loanRelay.calls).toEqual([]);
  });

  it('asks the limiter once per relay, with the client ip', async () => {
    const s = setup();
    await post(s, '/v1/loans/relay', { tx_b64: TX_B64 });
    expect(s.limiter.ips).toEqual(['203.0.113.7']);
  });

  it('shares one limiter with create: a refused ip is refused on both routes', async () => {
    const s = setup({ allow: false });
    const create = await post(s, '/v1/sessions', CREATE_BODY);
    const relay = await post(s, '/v1/loans/relay', { tx_b64: TX_B64 });
    expect([create.status, relay.status]).toEqual([429, 429]);
  });

  it('rejects a body over 4 KiB with 413 body_too_large', async () => {
    const s = setup();
    const res = await post(s, '/v1/loans/relay', { tx_b64: TX_B64, pad: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: 'body_too_large', stage: 'gateway' });
    expect(s.loanRelay.calls).toEqual([]);
  });

  it.each([
    ['not JSON', '{"tx_b64":'],
    ['a missing tx_b64', {}],
    ['an empty tx_b64', { tx_b64: '' }],
    ['a non-string tx_b64', { tx_b64: 5 }],
    ['non-base64 characters', { tx_b64: 'not base64 !!' }],
    ['base64url characters', { tx_b64: 'ab-_' }],
    ['more than 2048 characters', { tx_b64: 'A'.repeat(2049) }],
    ['an unknown member', { tx_b64: TX_B64, extra: 1 }],
  ])('rejects %s with 400 bad_request', async (_name, body) => {
    const s = setup();
    const res = await post(s, '/v1/loans/relay', body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: 'bad_request', stage: 'gateway' });
    expect(s.loanRelay.calls).toEqual([]);
  });

  it('accepts exactly 2048 base64 characters', async () => {
    const s = setup();
    const res = await post(s, '/v1/loans/relay', { tx_b64: 'A'.repeat(2048) });
    expect(res.status).toBe(200);
  });

  it('answers bad_transaction 400 with the rule in detail and a fixed message', async () => {
    const s = setup({
      loanRelay: fakeLoanRelay(async () => {
        throw gatewayError('bad_transaction', 'gateway', 400, { rule: 8 });
      }),
    });
    const res = await post(s, '/v1/loans/relay', { tx_b64: TX_B64 });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: {
        code: 'bad_transaction',
        message: 'The transaction is not an accepted loan transaction.',
        stage: 'gateway',
        detail: { rule: 8 },
      },
    });
  });

  it('answers relay_in_flight 429', async () => {
    const s = setup({
      loanRelay: fakeLoanRelay(async () => {
        throw gatewayError('relay_in_flight', 'gateway', 429);
      }),
    });
    const res = await post(s, '/v1/loans/relay', { tx_b64: TX_B64 });
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({
      error: {
        code: 'relay_in_flight',
        message: 'A relay for this wallet is already in progress; try again shortly.',
        stage: 'gateway',
      },
    });
  });

  it('carries detail { index, custom } on simulation_failed 409', async () => {
    const s = setup({
      loanRelay: fakeLoanRelay(async () => {
        throw gatewayError('simulation_failed', 'chain', 409, { index: 1, custom: 6008 });
      }),
    });
    const res = await post(s, '/v1/loans/relay', { tx_b64: TX_B64 });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({
      error: {
        code: 'simulation_failed',
        message: 'The transaction would fail on chain; see detail.',
        stage: 'chain',
        detail: { index: 1, custom: 6008 },
      },
    });
  });

  it('leaves detail out of errors that have none', async () => {
    const s = setup({
      loanRelay: fakeLoanRelay(async () => {
        throw gatewayError('tx_failed', 'chain', 502);
      }),
    });
    const res = await post(s, '/v1/loans/relay', { tx_b64: TX_B64 });
    expect(res.status).toBe(502);
    const error = (await json(res))['error'];
    expect(error).not.toHaveProperty('detail');
  });

  it('answers an unexpected exception with 500 internal_error and no detail', async () => {
    const s = setup({
      loanRelay: fakeLoanRelay(async () => {
        throw new Error('secret internals');
      }),
    });
    const res = await post(s, '/v1/loans/relay', { tx_b64: TX_B64 });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body).toMatchObject({ error: { code: 'internal_error' } });
    expect(JSON.stringify(body)).not.toContain('secret internals');
  });

  it('sets the CORS header on relay replies', async () => {
    const res = await post(setup(), '/v1/loans/relay', { tx_b64: TX_B64 }, { origin: ORIGIN });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});
