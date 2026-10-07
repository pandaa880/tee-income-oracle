/**
 * HTTP surface of the live sandbox bank (Hono). Each body is read once as
 * raw bytes (signatures cover exact bytes) and capped at 64 KiB; every
 * success reply carries the AA's detached JWS over its exact bytes in
 * `x-jws-signature`, as ReBIT requires of every response.
 *
 *   POST /fiu-keys    register an enclave's FIU key (FORMATS §8.1 binding)
 *   POST /Consent     issue an AA-signed consent for a persona (§5.3)
 *   POST /FI/request  FIU-signed FI request (§5.1) → ack with a sessionId
 *   POST /FI/fetch    the AA-signed fetch response (§5.2), once per session
 *   GET  /health
 */

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { signDetached } from '../crypto/jws.ts';
import { createBank, type BankDeps, type BankReply } from './bank.ts';
import { errorReply, type RebitCode, type RebitStatus } from './rebit-error.ts';

const MAX_BODY_BYTES = 64 * 1024;

/** The request body as exact bytes (read once). */
async function raw(c: Context): Promise<Uint8Array> {
  return new Uint8Array(await c.req.arrayBuffer());
}

export function createApp(deps: BankDeps): Hono {
  const bank = createBank(deps);
  const app = new Hono();

  const fail = (c: Context, code: RebitCode, txnid: string, status?: RebitStatus): Response => {
    const e = errorReply(code, txnid, deps.now(), status);
    return c.json(e.body, e.status);
  };
  const send = (c: Context, r: BankReply): Response => {
    if (!r.ok) {
      return fail(c, r.code, r.txnid);
    }
    return c.body(Uint8Array.from(r.body), 200, {
      'content-type': 'application/json',
      'x-jws-signature': r.jws ?? signDetached(r.body, deps.aa),
    });
  };

  app.onError((err, c) => {
    // The error's name only: messages could carry request data.
    process.stderr.write(`sandbox-bank: internal error (${err.name})\n`);
    return fail(c, 'InternalError', '');
  });
  app.notFound((c) => fail(c, 'InvalidRequest', '', 404));
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.use(
    '*',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 'InvalidRequest', '', 413) }),
  );
  app.post('/fiu-keys', async (c) => send(c, await bank.registerFiuKey(await raw(c))));
  app.post('/Consent', async (c) => send(c, bank.issueConsent(await raw(c))));
  app.post('/FI/request', async (c) =>
    send(c, await bank.fiRequest(await raw(c), c.req.header('x-jws-signature'))),
  );
  app.post('/FI/fetch', async (c) => send(c, bank.fetch(await raw(c))));
  return app;
}
