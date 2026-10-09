/**
 * Gateway errors (FORMATS §16): `{ error: { code, message, stage, detail? } }`.
 * Upstream codes (enclave §10, ReBIT `errorCode`) pass through unchanged so the
 * client sees which check failed; the message is always a fixed string, never
 * text from upstream or from an exception, so nothing request-derived leaks.
 * `detail` carries only numbers and checked identifiers (a shape rule, an
 * Anchor error code).
 */

export type Stage = 'gateway' | 'bank' | 'enclave' | 'chain';

// A Map, not an object: codes come from untrusted upstreams, and an object
// lookup of `constructor` or `toString` would return a prototype function.
const MESSAGES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    bad_request: 'The request body is invalid.',
    rate_limited: 'Too many requests; try again shortly.',
    session_not_found: 'Unknown session.',
    session_expired: 'The session has expired; start a new one.',
    body_too_large: 'The request body is too large.',
    enclave_rotated: 'The enclave restarted; the gateway must be reconfigured.',
    upstream_unavailable: 'An upstream service did not answer correctly.',
    stale_attestation: 'A newer attestation for this wallet is already on chain.',
    tx_failed: 'The attestation transaction failed.',
    internal_error: 'Internal error.',
    too_many_sessions: 'Too many open sessions; try again shortly.',
    not_found: 'Unknown route.',
    enclave_not_registered: 'The enclave is not registered on chain.',
    enclave_revoked: 'The enclave registry entry is revoked.',
    attester_mismatch: 'The enclave attester does not match its registry entry.',
    bad_transaction: 'The transaction is not an accepted loan transaction.',
    relay_in_flight: 'A relay for this wallet is already in progress; try again shortly.',
    simulation_failed: 'The transaction would fail on chain; see detail.',
  }),
);

const UPSTREAM_MESSAGE = 'An upstream check failed; see the code and stage.';

/** Machine-readable facts about a failure: shape rule numbers, instruction index, program code. */
export type ErrorDetail = Readonly<Record<string, number | string>>;

export class GatewayError extends Error {
  readonly code: string;
  readonly stage: Stage;
  readonly status: number;
  readonly detail?: ErrorDetail;

  constructor(code: string, stage: Stage, status: number, detail?: ErrorDetail) {
    super(`${stage}: ${code}`);
    this.name = 'GatewayError';
    this.code = code;
    this.stage = stage;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

export function gatewayError(
  code: string,
  stage: Stage,
  status = 502,
  detail?: ErrorDetail,
): GatewayError {
  return new GatewayError(code, stage, status, detail);
}

export type ErrorBody = {
  error: { code: string; message: string; stage: Stage; detail?: ErrorDetail };
};

export function errorBody(e: GatewayError): ErrorBody {
  return {
    error: {
      code: e.code,
      message: MESSAGES.get(e.code) ?? UPSTREAM_MESSAGE,
      stage: e.stage,
      ...(e.detail === undefined ? {} : { detail: e.detail }),
    },
  };
}
