import { describe, expect, it } from 'vitest';
import { messageFor, toAppError } from './errors.ts';
import type { AppError, VerifierErrorCode } from './types.ts';

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
    expect(['retry', 'restart', 'reattest', 'none']).toContain(message.action);
  });

  it('gives different codes different titles or details', () => {
    const texts = SIMPLE_CODES.map((code) => JSON.stringify(messageFor({ code })));
    expect(new Set(texts).size).toBe(SIMPLE_CODES.length);
  });

  it('explains a policy mismatch (6008) as the pool changing its criteria', () => {
    const message = messageFor({ code: 'simulation_failed', index: 1, custom: 6008 });
    expect(`${message.title} ${message.detail}`).toMatch(/pool changed its criteria/i);
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
    expect(message.action).toBe('retry');
  });

  it('gives an unknown upstream code the generic message, never the upstream text', () => {
    const message = messageFor({
      code: 'upstream_error',
      upstreamCode: 'bad_consent_signature',
      stage: 'enclave',
    });
    expect(message.title.length).toBeGreaterThan(0);
    expect(message.action).toBe('none');
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

  it.each([
    ...(['session_expired', 'session_not_found', 'enclave_rotated', 'cancelled'] as const).map(
      (code) => [code, { code }, 'restart'] as const,
    ),
    ...([6005, 6008, 6009, 6012, 6014] as const).map(
      (custom) =>
        [`simulation ${custom}`, { code: 'simulation_failed', custom }, 'reattest'] as const,
    ),
    ['enclave_revoked', { code: 'enclave_revoked' }, 'reattest'],
    ...(
      [
        'rate_limited',
        'relay_in_flight',
        'network',
        'rpc_busy',
        'timeout',
        'signing_failed',
        'tx_failed',
      ] as const
    ).map((code) => [code, { code }, 'retry'] as const),
    ['bad_transaction', { code: 'bad_transaction', rule: 4 }, 'retry'],
    ['invalid_amount', { code: 'invalid_amount', reason: 'empty' }, 'retry'],
    ['simulation 6002', { code: 'simulation_failed', custom: 6002 }, 'retry'],
    ['simulation 6007', { code: 'simulation_failed', custom: 6007 }, 'retry'],
    ['sponsorship_exhausted', { code: 'sponsorship_exhausted' }, 'none'],
    ['loan_exists', { code: 'loan_exists' }, 'none'],
    ['simulation 6006', { code: 'simulation_failed', custom: 6006 }, 'none'],
    ['simulation unknown', { code: 'simulation_failed', custom: 9999 }, 'none'],
    ['upstream_error', { code: 'upstream_error', upstreamCode: 'x', stage: 'enclave' }, 'none'],
  ] as readonly (readonly [string, AppError, string])[])(
    'maps %s to the %s action',
    (_, error, action) => {
      expect(messageFor(error).action).toBe(action);
    },
  );

  it.each([...SIMPLE_CODES, 'loan_exists', 'no_open_loan', 'signing_failed'] as const)(
    'gives every gateway and client code (%s) an action',
    (code) => {
      expect(['retry', 'restart', 'reattest', 'none']).toContain(messageFor({ code }).action);
    },
  );

  it('never crashes on a value that is not really an AppError', () => {
    const stray = { code: 'not_a_code' } as unknown as AppError;
    expect(messageFor(stray)).toEqual(messageFor({ code: 'protocol_error' }));
  });
});

// Typed as a record, so adding a code to the verifier fails the typecheck until it is listed here.
const VERIFIER_REASONS: Record<VerifierErrorCode, true> = {
  cose_malformed: true,
  cose_wrong_alg: true,
  cose_bad_signature_length: true,
  cose_signature_invalid: true,
  document_malformed: true,
  cert_malformed: true,
  root_not_pinned: true,
  chain_wrong_algorithm: true,
  chain_not_ca: true,
  chain_leaf_is_ca: true,
  chain_key_usage: true,
  chain_pathlen: true,
  chain_issuer_mismatch: true,
  chain_signature_invalid: true,
  chain_not_yet_valid: true,
  chain_expired: true,
  attestation_missing: true,
  attestation_malformed: true,
  entry_missing: true,
  entry_malformed: true,
  deployment_malformed: true,
  hex_malformed: true,
  fetch_failed: true,
  file_unreadable: true,
};
const REASONS = Object.keys(VERIFIER_REASONS) as VerifierErrorCode[];
const verifyMessage = (reason: VerifierErrorCode) => messageFor({ code: 'verify_failed', reason });
const NAMED = [
  'attestation_missing',
  'attestation_malformed',
  'entry_missing',
  'entry_malformed',
  'deployment_malformed',
  'fetch_failed',
  'hex_malformed',
  'file_unreadable',
] as const;
const GENERIC = verifyMessage('cose_malformed');

describe('messageFor verify_failed', () => {
  it.each(REASONS)('gives the reason %s a title, a detail and an action', (reason) => {
    const message = verifyMessage(reason);
    expect(message.title.trim().length).toBeGreaterThan(0);
    expect(message.detail.trim().length).toBeGreaterThan(0);
    expect(['retry', 'restart', 'reattest', 'none']).toContain(message.action);
  });

  it('tells a wallet without an attestation that only borrowers have a tier, with no action', () => {
    const message = verifyMessage('attestation_missing');
    expect(message.title).toBe('No tier for this wallet');
    expect(message.detail).toMatch(/borrow/i);
    expect(message.action).toBe('none');
  });

  it.each(['attestation_malformed', 'entry_malformed'] as const)(
    'says %s is a record the oracle did not write, with no action',
    (reason) => {
      const message = verifyMessage(reason);
      expect(message.title).toMatch(/not written by the oracle/i);
      expect(message.action).toBe('none');
    },
  );

  it('names a missing registry entry', () => {
    expect(verifyMessage('entry_missing').title).toBe('Enclave entry missing');
  });

  it('says the page has no archive for a build the deployment file lacks', () => {
    expect(verifyMessage('deployment_malformed').title).toBe('No archive for this build');
  });

  it('says GitHub could not be reached and offers Retry', () => {
    const message = verifyMessage('fetch_failed');
    expect(message.title).toBe('GitHub could not be reached');
    expect(message.action).toBe('retry');
  });

  it('says the archived document is unreadable for hex_malformed', () => {
    expect(verifyMessage('hex_malformed').title).toBe('Archived document unreadable');
  });

  it('tells a stale tab to reload when the archived document chunk did not load', () => {
    const message = verifyMessage('file_unreadable');
    expect(message.title).toBe('Archived document not loaded');
    expect(message.detail).toMatch(/reload/i);
    expect(message.action).toBe('none');
  });

  it('gives every other reason the generic "Verification could not run" with Retry', () => {
    const others = REASONS.filter((r) => !(NAMED as readonly string[]).includes(r));
    expect(others.length).toBeGreaterThan(10);
    for (const reason of others) {
      expect(verifyMessage(reason)).toEqual(GENERIC);
    }
    expect(GENERIC.title).toBe('Verification could not run');
    expect(GENERIC.action).toBe('retry');
  });

  it('gives the named reasons texts that differ from each other and from the generic one', () => {
    const texts = [...NAMED.map((r) => JSON.stringify(verifyMessage(r))), JSON.stringify(GENERIC)];
    expect(new Set(texts).size).toBe(NAMED.length + 1);
  });
});

describe('toAppError', () => {
  it('keeps a verify_failed error intact', () => {
    const error: AppError = { code: 'verify_failed', reason: 'entry_missing' };
    expect(toAppError(error)).toEqual({ code: 'verify_failed', reason: 'entry_missing' });
  });

  it('keeps a real AppError', () => {
    expect(toAppError({ code: 'loan_exists' })).toEqual({ code: 'loan_exists' });
    expect(toAppError({ code: 'bad_transaction', rule: 3 })).toEqual({
      code: 'bad_transaction',
      rule: 3,
    });
  });

  it.each([new RangeError('codec'), new Error('WebCrypto'), 'text', null, { code: 'nope' }])(
    'maps a stray throw (%s) to protocol_error',
    (thrown) => {
      expect(toAppError(thrown)).toEqual({ code: 'protocol_error' });
    },
  );
});
