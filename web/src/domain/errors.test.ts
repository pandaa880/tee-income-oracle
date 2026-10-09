import { describe, expect, it } from 'vitest';
import { messageFor } from './errors.ts';
import type { AppError } from './types.ts';

// Every code of FORMATS §16 plus the client-side ones (plan: AppError union).
const SIMPLE_CODES = [
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
  'protocol_error',
  'cancelled',
  'network',
  'rpc_busy',
  'timeout',
] as const;

// demo_pool borrow errors (FORMATS §14) the browser can see in `simulation_failed.custom`.
const ANCHOR_CODES = [6002, 6003, 6004, 6005, 6006, 6007, 6008, 6009, 6010, 6011, 6012, 6013, 6014];

const fallback = messageFor({ code: 'simulation_failed', kind: 'unknown' });

describe('messageFor', () => {
  it.each(SIMPLE_CODES)('gives %s a title and detail', (code) => {
    const message = messageFor({ code });
    expect(message.title.length).toBeGreaterThan(0);
    expect(message.detail.length).toBeGreaterThan(0);
    expect(typeof message.retry).toBe('boolean');
  });

  it('gives different codes different titles or details', () => {
    const texts = SIMPLE_CODES.map((code) => JSON.stringify(messageFor({ code })));
    expect(new Set(texts).size).toBe(SIMPLE_CODES.length);
  });

  it('explains a policy mismatch (6008) as the lender changing its rules', () => {
    const message = messageFor({ code: 'simulation_failed', index: 1, custom: 6008 });
    expect(`${message.title} ${message.detail}`).toMatch(/lender changed its rules/i);
    expect(`${message.title} ${message.detail}`).toMatch(/re-attest/i);
  });

  it.each(ANCHOR_CODES)('has a specific message for Anchor code %s', (custom) => {
    const message = messageFor({ code: 'simulation_failed', index: 1, custom });
    expect(message).not.toEqual(fallback);
  });

  it('gives each Anchor code its own detail', () => {
    const details = ANCHOR_CODES.map(
      (custom) => messageFor({ code: 'simulation_failed', index: 1, custom }).detail,
    );
    expect(new Set(details).size).toBe(ANCHOR_CODES.length);
  });

  it('falls back to a generic message for an unknown program code or a named error', () => {
    expect(messageFor({ code: 'simulation_failed', index: 1, custom: 9999 })).toEqual(fallback);
    expect(messageFor({ code: 'simulation_failed', kind: 'InsufficientFunds' })).toEqual(fallback);
    expect(fallback.detail.length).toBeGreaterThan(0);
  });

  it('names the failed shape rule for bad_transaction', () => {
    const message = messageFor({ code: 'bad_transaction', rule: 7 });
    expect(`${message.title} ${message.detail}`).toContain('7');
    expect(message.retry).toBe(false);
  });

  it('gives an unknown upstream code the generic message, never the upstream text', () => {
    const message = messageFor({
      code: 'upstream_error',
      upstreamCode: 'bad_consent_signature',
      stage: 'enclave',
    });
    expect(message.title.length).toBeGreaterThan(0);
    expect(message.retry).toBe(false);
  });

  it.each([
    'zero',
    'negative',
    'too_many_decimals',
    'not_a_number',
    'over_limit',
    'empty',
  ] as const)('explains an invalid amount (%s)', (reason) => {
    const error: AppError = { code: 'invalid_amount', reason };
    expect(messageFor(error).detail.length).toBeGreaterThan(0);
  });

  it('marks transient failures retryable and permanent ones not', () => {
    for (const code of [
      'network',
      'rate_limited',
      'rpc_busy',
      'relay_in_flight',
      'timeout',
    ] as const) {
      expect(messageFor({ code }).retry).toBe(true);
    }
    for (const code of ['sponsorship_exhausted', 'enclave_revoked', 'session_expired'] as const) {
      expect(messageFor({ code }).retry).toBe(false);
    }
  });
});
