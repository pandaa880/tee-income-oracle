// The gateway HTTP API (FORMATS §16). The `complete` reply is a live SSE stream, read event by
// event so the processing screen shows each stage as it starts.
import { type Address, address } from '@solana/kit';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { z } from 'zod';
import { errorFrom, errorOfResponse, fetchFailure, protocolError, requestJson } from './http.ts';
import type { GatewayPort } from '../domain/ports.ts';
import type { AppError, FlowEvent, Info, PersonaId, Session } from '../domain/types.ts';

const MAX_EVENT_BYTES = 65_536;

/** UTF-8 bytes → text, keeping a character split across chunks whole (`stream: true`). */
function utf8Decoder(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder();
  return new TransformStream({
    transform: (chunk, out) => out.enqueue(decoder.decode(chunk, { stream: true })),
    flush: (out) => {
      const rest = decoder.decode();
      if (rest !== '') out.enqueue(rest);
    },
  });
}

const addressSchema = z.string().transform((s, ctx) => {
  try {
    return address(s);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not an address' });
    return z.NEVER;
  }
});

/** FORMATS §0: session ids are lowercase hyphenated UUIDv4 (they go into signed text and URLs). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sessionSchema = z.object({
  session_id: z.string().regex(UUID_V4),
  intent: z.string(),
  intent_expires: z.number().int(),
});

const infoSchema = z.object({
  cluster: z.string(),
  oracle_program: addressSchema,
  credential: addressSchema,
  schema: addressSchema,
  measurement_id: z.number().int().min(0).max(255),
  policy_hash: z.string().regex(/^[0-9a-f]{64}$/i),
  attester_address: z.string().regex(/^0x[0-9a-f]{40}$/i),
  relayer: addressSchema,
});

const stageSchema = z.object({
  stage: z.enum(['bind', 'fi_request', 'fi_fetch', 'evaluate', 'submit']),
});

const resultSchema = z.union([
  z.object({
    tier: z.enum(['A', 'B', 'C']),
    tx: z.string().nullable(),
    attestation: addressSchema,
    expiry: z.number().int(),
    payload_hex: z.string().regex(/^[0-9a-f]{166}$/i),
  }),
  z.object({ tier: z.literal('REJECT') }),
]);

const streamErrorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  stage: z.string().optional(),
  detail: z.unknown().optional(),
});

const fail = (error: AppError): FlowEvent => ({ kind: 'error', error });

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/** One SSE message → a typed event, or `protocol_error` for anything we didn't expect. */
export function toFlowEvent(event: string | undefined, data: string): FlowEvent {
  const json = parseJson(data);
  if (event === 'stage') {
    const parsed = stageSchema.safeParse(json);
    return parsed.success ? { kind: 'stage', stage: parsed.data.stage } : fail(protocolError);
  }
  if (event === 'result') {
    const parsed = resultSchema.safeParse(json);
    if (!parsed.success) return fail(protocolError);
    const r = parsed.data;
    if (r.tier === 'REJECT') return { kind: 'result', result: { tier: 'REJECT' } };
    return {
      kind: 'result',
      result: {
        tier: r.tier,
        tx: r.tx,
        attestation: r.attestation,
        expiry: BigInt(r.expiry),
        payloadHex: r.payload_hex,
      },
    };
  }
  if (event === 'error') {
    const parsed = streamErrorSchema.safeParse(json);
    return fail(parsed.success ? errorFrom(parsed.data) : protocolError);
  }
  return fail(protocolError);
}

async function* readEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body
    .pipeThrough(utf8Decoder())
    .pipeThrough(
      new EventSourceParserStream({ onError: 'terminate', maxBufferSize: MAX_EVENT_BYTES }),
    )
    .getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        yield fail(protocolError); // the stream ended without a result or an error
        return;
      }
      const event = toFlowEvent(value.event, value.data);
      yield event;
      if (event.kind !== 'stage') {
        // A result or an error ends the session: close the connection instead of idling on
        // keep-alives.
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } catch {
    // An abort errors the body; anything else is a broken or oversized stream.
    yield fail(signal.aborted ? { code: 'cancelled' } : protocolError);
  } finally {
    reader.releaseLock();
  }
}

async function* completeSession(
  baseUrl: string,
  sessionId: string,
  signatureB58: string,
  signal: AbortSignal,
): AsyncGenerator<FlowEvent> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/complete`, {
      method: 'POST',
      signal,
      body: JSON.stringify({ signature_b58: signatureB58 }),
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    });
  } catch (cause) {
    yield fail(fetchFailure(cause, signal));
    return;
  }
  if (!response.ok || response.body === null) {
    yield fail(response.ok ? protocolError : await errorOfResponse(response));
    return;
  }
  yield* readEvents(response.body, signal);
}

export function createGateway(baseUrl: string): GatewayPort {
  return {
    createSession: (wallet: Address, persona: PersonaId, signal: AbortSignal) =>
      requestJson(
        `${baseUrl}/v1/sessions`,
        { method: 'POST', body: { wallet, persona_id: persona } },
        sessionSchema,
        (s): Session => ({
          sessionId: s.session_id,
          intent: s.intent,
          intentExpires: BigInt(s.intent_expires),
        }),
        signal,
      ),
    completeSession: (sessionId, signatureB58, signal) =>
      completeSession(baseUrl, sessionId, signatureB58, signal),
    info: (signal) =>
      requestJson(
        `${baseUrl}/v1/info`,
        { method: 'GET' },
        infoSchema,
        (i): Info => ({
          cluster: i.cluster,
          oracleProgram: i.oracle_program,
          credential: i.credential,
          schema: i.schema,
          measurementId: i.measurement_id,
          policyHash: i.policy_hash,
          attesterAddress: i.attester_address,
          relayer: i.relayer,
        }),
        signal,
      ),
    health: (signal) =>
      requestJson(
        `${baseUrl}/health`,
        { method: 'GET' },
        z.object({ status: z.literal('ok') }),
        () => true as const,
        signal,
      ),
  };
}
