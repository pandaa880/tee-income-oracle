/**
 * HTTP clients for the enclave (FORMATS §10) and the sandbox bank (§15).
 * Signed bodies travel as exact bytes; replies are size-capped and
 * schema-checked. Upstream errors keep their code and stage (a 5xx answers
 * 502); anything unreadable is `upstream_unavailable`. Upstream message text
 * is never kept.
 */
import { z } from 'zod';

import { type Stage, gatewayError } from './errors.ts';

const TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 64 * 1024;
/** The fetch response carries the encrypted statement; the enclave accepts 8 MiB of base64. */
const MAX_FETCH_REPLY_BYTES = 6 * 1024 * 1024;
const REBIT_VERSION = '1.1.3';

type Fetch = typeof fetch;
type Reply = { status: number; bytes: Uint8Array; headers: Headers };

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) return new Uint8Array(Buffer.concat(chunks));
    const value: unknown = result.value;
    if (!(value instanceof Uint8Array)) return undefined;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

async function send(
  fetchFn: Fetch,
  stage: Stage,
  url: string,
  init: RequestInit,
  maxBytes = MAX_REPLY_BYTES,
): Promise<Reply> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw gatewayError('upstream_unavailable', stage, 502);
  }
  const bytes = await readCapped(res, maxBytes).catch(() => undefined);
  if (bytes === undefined) throw gatewayError('upstream_unavailable', stage, 502);
  return { status: res.status, bytes, headers: res.headers };
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return value;
  } catch {
    return undefined;
  }
}

// Upstream codes are passed to the client and logged: only short identifiers,
// so an untrusted upstream can't forge log lines or push arbitrary text.
const upstreamCode = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const enclaveErrorSchema = z.object({ error: z.object({ code: upstreamCode }) });
const bankErrorSchema = z.object({ errorCode: upstreamCode });

/** A non-2xx reply → GatewayError with the upstream code (5xx answers 502). */
function upstreamFailure(stage: Stage, reply: Reply): never {
  const body = parseJson(reply.bytes);
  const code =
    stage === 'enclave'
      ? enclaveErrorSchema.safeParse(body).data?.error.code
      : bankErrorSchema.safeParse(body).data?.errorCode;
  if (code === undefined) throw gatewayError('upstream_unavailable', stage, 502);
  throw gatewayError(code, stage, reply.status >= 500 ? 502 : reply.status);
}

function parseReply<T>(stage: Stage, reply: Reply, schema: z.ZodType<T>): T {
  if (reply.status < 200 || reply.status > 299) upstreamFailure(stage, reply);
  const parsed = schema.safeParse(parseJson(reply.bytes));
  if (!parsed.success) throw gatewayError('upstream_unavailable', stage, 502);
  return parsed.data;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// --- enclave (FORMATS §10) ------------------------------------------------

const infoSchema = z.object({
  app_version: z.string(),
  attester_address: z.string(),
  // Loose: the JWK goes to the bank exactly as the enclave sent it.
  fiu_public_jwk: z.looseObject({ kid: z.string().min(1) }),
  fiu_key_signature_hex: z.string(),
  pinned_kids: z.array(z.string()),
});
const createdSchema = z.object({
  session_id: z.uuid(),
  key_material: z.unknown(),
  fi_request_body_b64: z.string(),
  fi_request_jws: z.string(),
  intent: z.string(),
  intent_expires: z.number().int(),
});
const boundSchema = z.object({ status: z.literal('bound') });
const evaluationSchema = z.discriminatedUnion('tier', [
  z.object({
    tier: z.enum(['A', 'B', 'C']),
    payload_hex: z.string().regex(/^[0-9a-f]{166}$/), // 83-byte payload (§7)
    signature_hex: z.string().regex(/^[0-9a-f]{130}$/), // r ‖ s ‖ v (§8)
    expiry: z.number().int(),
  }),
  z.object({ tier: z.literal('REJECT') }),
]);

export type EnclaveInfo = z.infer<typeof infoSchema>;
export type CreatedSession = z.infer<typeof createdSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;

export type EnclaveClient = {
  info: () => Promise<EnclaveInfo>;
  createSession: (body: {
    policy: unknown;
    wallet: string;
    consent_jws: string;
    measurement_id: number;
  }) => Promise<CreatedSession>;
  bind: (
    id: string,
    body: { wallet: string; signature_b58: string },
  ) => Promise<{ status: 'bound' }>;
  evaluate: (
    id: string,
    body: { fetch_response_b64: string; fetch_response_jws: string; consent_jws: string },
  ) => Promise<Evaluation>;
};

const sessionPath = (id: string, action: string): string =>
  `/v1/sessions/${encodeURIComponent(id)}/${action}`;

export function createEnclaveClient(baseUrl: string, fetchFn: Fetch = fetch): EnclaveClient {
  const call = async <T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> =>
    parseReply('enclave', await send(fetchFn, 'enclave', `${baseUrl}${path}`, init), schema);
  return {
    info: () => call('/v1/info', { method: 'GET' }, infoSchema),
    createSession: (body) => call('/v1/sessions', jsonPost(body), createdSchema),
    bind: (id, body) => call(sessionPath(id, 'bind'), jsonPost(body), boundSchema),
    evaluate: (id, body) => call(sessionPath(id, 'evaluate'), jsonPost(body), evaluationSchema),
  };
}

// --- sandbox bank (FORMATS §15) -------------------------------------------

const fiuKeySchema = z.object({ kid: z.string(), attester: z.string() });
const consentSchema = z.object({
  ver: z.string(),
  timestamp: z.string(),
  consentId: z.string(),
  signedConsent: z.string(),
});
const fiAckSchema = z.object({
  ver: z.string(),
  timestamp: z.string(),
  txnid: z.string(),
  consentId: z.string(),
  sessionId: z.string(),
});

export type ConsentReply = z.infer<typeof consentSchema>;
export type FiAck = z.infer<typeof fiAckSchema>;

export type BankClient = {
  registerFiuKey: (body: {
    fiu_public_jwk: EnclaveInfo['fiu_public_jwk'];
    fiu_key_signature_hex: string;
  }) => Promise<{ kid: string; attester: string }>;
  consent: (personaId: string) => Promise<ConsentReply>;
  fiRequest: (body: Uint8Array, jws: string) => Promise<FiAck>;
  /** The AA-signed fetch response: exact bytes plus its detached JWS. */
  fiFetch: (ids: {
    txnid: string;
    sessionId: string;
  }) => Promise<{ bytes: Uint8Array; jws: string }>;
};

export function createBankClient(baseUrl: string, fetchFn: Fetch = fetch): BankClient {
  const post = (path: string, init: RequestInit, maxBytes?: number) =>
    send(fetchFn, 'bank', `${baseUrl}${path}`, init, maxBytes);
  return {
    registerFiuKey: async (body) =>
      parseReply('bank', await post('/fiu-keys', jsonPost(body)), fiuKeySchema),
    consent: async (personaId) =>
      parseReply(
        'bank',
        await post('/Consent', jsonPost({ persona_id: personaId })),
        consentSchema,
      ),
    fiRequest: async (body, jws) => {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jws-signature': jws },
        body: Uint8Array.from(body),
      };
      return parseReply('bank', await post('/FI/request', init), fiAckSchema);
    },
    fiFetch: async ({ txnid, sessionId }) => {
      const body = { ver: REBIT_VERSION, timestamp: new Date().toISOString(), txnid, sessionId };
      const reply = await post('/FI/fetch', jsonPost(body), MAX_FETCH_REPLY_BYTES);
      if (reply.status < 200 || reply.status > 299) upstreamFailure('bank', reply);
      const jws = reply.headers.get('x-jws-signature');
      if (jws === null || jws === '') throw gatewayError('upstream_unavailable', 'bank', 502);
      return { bytes: reply.bytes, jws };
    },
  };
}
