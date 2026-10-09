/**
 * HTTP surface of the gateway (Hono, FORMATS §16).
 *
 *   POST /v1/sessions               { wallet, persona_id } → { session_id, intent, intent_expires }
 *   POST /v1/sessions/:id/complete  { signature_b58 } → text/event-stream of stages, then result
 *   POST /v1/loans/relay            { tx_b64 } → { signature }: the relayer co-signs a borrow/repay
 *   GET  /v1/info                   deployment facts for the web
 *   GET  /health
 *
 * Errors before a stream opens are JSON `{ error: { code, message, stage } }`;
 * once it is open they are an `event: error`. Logs carry the session id,
 * stage and code only, never bodies.
 */
import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { GatewayError, errorBody, gatewayError } from './errors.ts';
import { type Deps, createSession, runSession, takeSession } from './flow.ts';
import type { LoanRelay } from './loan-relay-flow.ts';
import type { RateLimiter } from './rate-limit.ts';

const MAX_BODY_BYTES = 4 * 1024;
/** SSE comment interval: keeps proxies from closing a quiet stream (submit can take a minute). */
const KEEP_ALIVE_MS = 15_000;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** A v0 transaction is at most 1232 bytes, 1644 base64 characters. */
const MAX_TX_B64 = 2048;
const PERSONAS = ['salaried_steady', 'trader_lumpy', 'declining', 'stressed'] as const;

const createSchema = z.strictObject({
  wallet: z.string().min(32).max(44).regex(BASE58),
  persona_id: z.enum(PERSONAS),
});
const completeSchema = z.strictObject({
  signature_b58: z.string().min(1).max(88).regex(BASE58),
});
const relaySchema = z.strictObject({
  tx_b64: z.string().min(1).max(MAX_TX_B64).regex(BASE64),
});

export type GatewayInfo = {
  cluster: string;
  oracle_program: string;
  credential: string;
  schema: string;
  measurement_id: number;
  policy_hash: string;
  attester_address: string;
  /** Fee payer the browser names when it builds a loan transaction for `/v1/loans/relay`. */
  relayer: string;
};

export type AppDeps = Deps & {
  loanRelay: LoanRelay;
  rateLimiter: RateLimiter;
  config: { allowedOrigin: string; trustProxy: boolean; info: GatewayInfo };
  /** Test hook; defaults to X-Forwarded-For (when trusted) or the socket address. */
  clientIp?: (c: Context) => string;
};

/** Any thrown value as a GatewayError; unexpected ones become a detail-free internal_error. */
function asGatewayError(e: unknown): GatewayError {
  return e instanceof GatewayError ? e : gatewayError('internal_error', 'gateway', 500);
}

function log(session: string, e: GatewayError): void {
  process.stderr.write(`gateway: session=${session} stage=${e.stage} code=${e.code}\n`);
}

/**
 * The client IP for the rate limiter. Behind our one trusted proxy (Azure
 * ingress, `TRUST_PROXY=1`) it is the LAST `X-Forwarded-For` hop: the proxy
 * appends the peer it saw, while every earlier hop is client-written and
 * spoofable.
 */
function defaultClientIp(trustProxy: boolean): (c: Context) => string {
  return (c) => {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (trustProxy && forwarded !== undefined && forwarded !== '') return forwarded;
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown'; // no socket (in-process requests)
    }
  };
}

function fail(e: GatewayError): Response {
  return new Response(JSON.stringify(errorBody(e)), {
    status: e.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The JSON body checked against `schema`; anything else is bad_request. */
async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await c.req.text());
  } catch {
    throw gatewayError('bad_request', 'gateway', 400);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw gatewayError('bad_request', 'gateway', 400);
  return result.data;
}

/**
 * POST /v1/sessions/:id/complete. The body is checked before the session is
 * taken (a malformed request doesn't burn it); after that every outcome is an
 * SSE event. Writes are chained in order and never throw: a client that hangs
 * up doesn't stop the flow (the attestation may still land on chain).
 */
async function complete(deps: AppDeps, c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const body = await readBody(c, completeSchema);
  const taken = takeSession(deps, id);
  return streamSSE(c, async (stream) => {
    let writes = Promise.resolve();
    const enqueue = (send: () => Promise<void>): void => {
      writes = writes.then(send).catch(() => {});
    };
    const write = (event: string, data: unknown): void =>
      enqueue(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
    const keepAlive = setInterval(
      () => enqueue(() => stream.write(': keep-alive\n\n').then(() => {})),
      KEEP_ALIVE_MS,
    );
    try {
      write('result', await runSession(deps, taken, body, (stage) => write('stage', { stage })));
    } catch (err) {
      const e = asGatewayError(err);
      log(id, e);
      write('error', errorBody(e).error);
    } finally {
      clearInterval(keepAlive);
    }
    await writes;
  });
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const clientIp = deps.clientIp ?? defaultClientIp(deps.config.trustProxy);
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => fail(gatewayError('body_too_large', 'gateway', 413)),
  });

  app.use(
    '*',
    cors({
      origin: deps.config.allowedOrigin,
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['content-type'],
    }),
  );
  app.onError((err) => {
    const e = asGatewayError(err);
    log('-', e);
    return fail(e);
  });
  app.notFound(() => fail(gatewayError('not_found', 'gateway', 404)));

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/v1/info', (c) => c.json(deps.config.info));
  // Create and relay share the buckets: both start work that costs the gateway something.
  const rateLimit = async (c: Context, next: () => Promise<void>) =>
    deps.rateLimiter.allow(clientIp(c))
      ? next()
      : fail(gatewayError('rate_limited', 'gateway', 429));
  app.post('/v1/sessions', rateLimit, limitBody, async (c) =>
    c.json(await createSession(deps, await readBody(c, createSchema))),
  );
  app.post('/v1/sessions/:id/complete', limitBody, (c) => complete(deps, c));
  app.post('/v1/loans/relay', rateLimit, limitBody, async (c) =>
    c.json(await deps.loanRelay.relay(await readBody(c, relaySchema))),
  );
  return app;
}
