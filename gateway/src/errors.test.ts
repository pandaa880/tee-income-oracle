import { describe, expect, it } from 'vitest';

import { GatewayError, errorBody, gatewayError } from './errors.ts';

const GATEWAY_CODES = [
  'bad_request',
  'rate_limited',
  'session_not_found',
  'session_expired',
  'body_too_large',
  'enclave_rotated',
  'upstream_unavailable',
  'stale_attestation',
  'tx_failed',
  'internal_error',
  'too_many_sessions',
  'not_found',
] as const;

describe('gatewayError', () => {
  it('builds a GatewayError (an Error subclass) carrying code, stage and status', () => {
    const e = gatewayError('rate_limited', 'gateway', 429);
    expect(e).toBeInstanceOf(GatewayError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('rate_limited');
    expect(e.stage).toBe('gateway');
    expect(e.status).toBe(429);
  });

  it('defaults to an HTTP error status when none is given', () => {
    const e = gatewayError('tx_failed', 'chain');
    expect(Number.isInteger(e.status)).toBe(true);
    expect(e.status).toBeGreaterThanOrEqual(400);
    expect(e.status).toBeLessThanOrEqual(599);
  });
});

describe('errorBody', () => {
  it('has exactly { error: { code, message, stage } }', () => {
    const body = errorBody(gatewayError('bad_request', 'gateway', 400));
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).toSorted()).toEqual(['code', 'message', 'stage']);
    expect(body.error.code).toBe('bad_request');
    expect(body.error.stage).toBe('gateway');
  });

  it.each(GATEWAY_CODES)('gives gateway code %s a non-empty fixed message', (code) => {
    const first = errorBody(gatewayError(code, 'gateway', 400)).error.message;
    const second = errorBody(gatewayError(code, 'gateway', 400)).error.message;
    expect(first.length).toBeGreaterThan(0);
    expect(first).toBe(second);
  });

  it('gives different known codes different messages', () => {
    const messages = GATEWAY_CODES.map(
      (c) => errorBody(gatewayError(c, 'gateway', 400)).error.message,
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('keeps the upstream code unchanged and uses one generic message for any upstream code', () => {
    const a = errorBody(gatewayError('bad_aa_signature', 'enclave', 422));
    const b = errorBody(gatewayError('SignatureDoesNotMatch', 'bank', 400));
    const c = errorBody(gatewayError('some_future_code', 'enclave', 422));
    expect(a.error.code).toBe('bad_aa_signature');
    expect(b.error.code).toBe('SignatureDoesNotMatch');
    expect(a.error.message.length).toBeGreaterThan(0);
    expect(a.error.message).toBe(b.error.message);
    expect(a.error.message).toBe(c.error.message);
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'gives the prototype-named upstream code %s the generic string message',
    (code) => {
      const body = errorBody(gatewayError(code, 'bank', 400));
      expect(body.error.message).toBe(errorBody(gatewayError('x_y', 'bank', 400)).error.message);
    },
  );

  it('never puts the upstream code or stage text into the generic message', () => {
    const body = errorBody(gatewayError('bad_aa_signature', 'enclave', 422));
    expect(body.error.message).not.toContain('bad_aa_signature');
  });

  it('never leaks the Error.message of the thrown error', () => {
    const e = gatewayError('tx_failed', 'chain', 502);
    e.message = 'rpc said: secret-detail-123';
    expect(JSON.stringify(errorBody(e))).not.toContain('secret-detail-123');
  });
});
