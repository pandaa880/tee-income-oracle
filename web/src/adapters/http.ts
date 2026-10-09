// JSON over fetch for the gateway adapters: every outcome is a Result, never a throw.
import { z } from 'zod';
import type { AppError, GatewayCode, Result } from '../domain/types.ts';

const GATEWAY_CODES = new Set<string>([
  'bad_request',
  'not_found',
  'session_not_found',
  'session_expired',
  'body_too_large',
  'rate_limited',
  'relay_in_flight',
  'sponsorship_exhausted',
  'internal_error',
  'too_many_sessions',
  'upstream_unavailable',
  'enclave_rotated',
  'stale_attestation',
  'tx_failed',
  'enclave_not_registered',
  'enclave_revoked',
  'attester_mismatch',
] satisfies GatewayCode[]);

const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
    stage: z.string().optional(),
    detail: z.unknown().optional(),
  }),
});

const ruleDetail = z.object({ rule: z.number().int() });
const simulationDetail = z.object({
  index: z.number().int().optional(),
  custom: z.number().int().optional(),
  kind: z.string().optional(),
});

export const protocolError: AppError = { code: 'protocol_error' };

const isGatewayCode = (code: string): code is GatewayCode => GATEWAY_CODES.has(code);

type ErrorFields = z.infer<typeof errorBodySchema>['error'];

/** A §16 error object → AppError. Codes we don't know (enclave, bank) stay upstream errors. */
export function errorFrom({ code, message, stage, detail }: ErrorFields): AppError {
  const text = message === undefined ? {} : { message };
  if (code === 'bad_transaction') {
    const parsed = ruleDetail.safeParse(detail);
    return parsed.success ? { code, rule: parsed.data.rule, ...text } : protocolError;
  }
  if (code === 'simulation_failed') {
    const parsed = simulationDetail.safeParse(detail ?? {});
    if (!parsed.success) return protocolError;
    const { index, custom, kind } = parsed.data;
    return {
      code,
      ...(index === undefined ? {} : { index }),
      ...(custom === undefined ? {} : { custom }),
      ...(kind === undefined ? {} : { kind }),
      ...text,
    };
  }
  if (isGatewayCode(code)) {
    return { code, ...text, ...(stage === undefined ? {} : { stage }) };
  }
  return { code: 'upstream_error', upstreamCode: code, stage: stage ?? 'unknown', ...text };
}

/** A failed fetch: our own abort is `cancelled`, anything else `network`. */
export function fetchFailure(cause: unknown, signal: AbortSignal): AppError {
  const aborted = signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError');
  return { code: aborted ? 'cancelled' : 'network' };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    return undefined;
  }
}

/** The JSON error of a non-2xx reply, or `protocol_error` when the body isn't one. */
export async function errorOfResponse(response: Response): Promise<AppError> {
  const parsed = errorBodySchema.safeParse(await readJson(response));
  return parsed.success ? errorFrom(parsed.data.error) : protocolError;
}

/** GET or POST JSON; the reply is parsed with `schema`, and `map` shapes it for the domain. */
export async function requestJson<S extends z.ZodType, T>(
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  schema: S,
  map: (value: z.infer<S>) => T,
  signal: AbortSignal,
): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      signal,
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
    });
  } catch (cause) {
    return { ok: false, error: fetchFailure(cause, signal) };
  }
  if (!response.ok) return { ok: false, error: await errorOfResponse(response) };
  const body = await readJson(response);
  if (signal.aborted) return { ok: false, error: { code: 'cancelled' } };
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, value: map(parsed.data) }
    : { ok: false, error: protocolError };
}
