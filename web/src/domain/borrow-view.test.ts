import { getBase16Codec } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  acceptingPools,
  type BorrowView,
  borrowView,
  confirmationEpoch,
  expireConsent,
  isRecoverable,
  isTransportFailure,
  shouldPollCredential,
} from './borrow-view.ts';
import type { FlowState } from './flow.ts';
import type { AppError, Session, Stage } from './types.ts';
import { credentialRecord } from '../test-support/credential.ts';
import { ADMIN, ISSUED_AT, OTHER, payloadBytes, POOL_0 } from '../test-support/fixtures.ts';

const ATTESTATION = OTHER;
const session: Session = { sessionId: 's', intent: 'intent', intentExpires: 99n };
const wallet = ADMIN;

const flows = {
  wallet: { step: 'wallet' },
  persona: { step: 'persona', wallet },
  consent: { step: 'consent', wallet, persona: 'trader_lumpy', session },
  processing: {
    step: 'processing',
    wallet,
    persona: 'trader_lumpy',
    session,
    stages: ['bind', 'fi_request'] as Stage[],
  },
  // The stream's payload is the fixture default (issued_at = ISSUED_AT), the same attestation
  // `credentialRecord` builds unless a test overrides issuedAt.
  result: {
    step: 'result',
    wallet,
    tier: 'B',
    attestation: POOL_0,
    tx: 'sig',
    payloadHex: getBase16Codec().decode(payloadBytes({ tier: 2 })),
  },
  rejected: { step: 'rejected', wallet },
} satisfies Record<string, FlowState>;

/** `sent`: the signed intent reached the gateway before the failure (the default here). */
const failed = (error: AppError, sent = true): FlowState => ({
  step: 'failed',
  wallet,
  error,
  sent,
});
const valid = credentialRecord('valid', { payload: { tier: 3 } });
/** The chain record of exactly the payload `flows.result` reported (tier byte 2 = B). */
const confirmed = credentialRecord('valid', { payload: { tier: 2 } });
const view = (
  flow: FlowState,
  credential = undefined as ReturnType<typeof credentialRecord> | undefined,
  replacedIssuedAt: bigint | null = null,
) => borrowView({ flow, credential, attestation: ATTESTATION, replacedIssuedAt });

describe('borrowView without a credential', () => {
  it('maps wallet and persona 1:1', () => {
    expect(view(flows.wallet)).toEqual({ step: 'wallet' });
    expect(view(flows.persona)).toEqual({ step: 'persona' });
  });

  it('carries session, persona and wallet into consent', () => {
    expect(view(flows.consent)).toEqual({
      step: 'consent',
      session,
      persona: 'trader_lumpy',
      wallet,
    });
  });

  it('carries the received stages into processing', () => {
    expect(view(flows.processing)).toEqual({ step: 'processing', stages: ['bind', 'fi_request'] });
  });

  it('waits in confirming for a stream result the chain read does not show yet', () => {
    expect(view(flows.result)).toEqual({
      step: 'confirming',
      stages: ['bind', 'fi_request', 'fi_fetch', 'evaluate', 'submit'],
    });
  });

  it('is rejected for a rejected flow', () => {
    expect(view(flows.rejected)).toEqual({ step: 'rejected' });
  });

  it('keeps a non-transport failure as failed with its error', () => {
    const error: AppError = { code: 'session_expired' };
    expect(view(failed(error))).toEqual({ step: 'failed', error });
  });

  it.each(['network', 'timeout', 'rpc_busy'] as const)(
    'turns a %s failure into recovering',
    (code) => {
      expect(view(failed({ code }))).toEqual({ step: 'recovering' });
    },
  );
});

describe('borrowView with a credential', () => {
  it('shows a stream result once the chain holds exactly its payload, tier from the chain', () => {
    const result = view(flows.result, confirmed);
    expect(result).toMatchObject({ step: 'result', source: 'stream', tier: 'B', tx: 'sig' });
    expect(result).toHaveProperty('record', confirmed.record);
  });

  it('refuses a reported tier the chain contradicts (same issued_at, another tier)', () => {
    // A gateway relays a real tier C, then reports tier B for the same attestation.
    expect(view(flows.result, valid)).toEqual({
      step: 'failed',
      error: { code: 'protocol_error' },
    });
  });

  it.each(['foreign_signer', 'expired'] as const)(
    'refuses a matching payload whose record is %s',
    (status) => {
      const record = credentialRecord(status, { payload: { tier: 2 } });
      expect(view(flows.result, record)).toEqual({
        step: 'failed',
        error: { code: 'protocol_error' },
      });
    },
  );

  it.each([
    ['wallet', flows.wallet],
    ['persona', flows.persona],
    ['a transport failure', failed({ code: 'network' })],
  ])('shows the chain result when the flow is at %s and the credential is valid', (_, flow) => {
    expect(view(flow, valid)).toEqual({
      step: 'result',
      source: 'chain',
      tier: 'C',
      attestation: ATTESTATION,
      tx: null,
      record: valid.record,
    });
  });

  it.each([
    [1, 'A'],
    [2, 'B'],
    [3, 'C'],
  ] as const)('maps payload tier %i to %s', (byte, tier) => {
    const record = credentialRecord('valid', { payload: { tier: byte } });
    expect(view(flows.wallet, record)).toMatchObject({ source: 'chain', tier });
  });

  it('keeps the stream source (and its tx link) for a confirmed stream result', () => {
    expect(view(flows.result, confirmed)).toMatchObject({ source: 'stream', tx: 'sig' });
  });

  it('lets a rejected flow stay rejected', () => {
    expect(view(flows.rejected, valid)).toEqual({ step: 'rejected' });
  });

  it('does not override consent or processing', () => {
    expect(view(flows.consent, valid).step).toBe('consent');
    expect(view(flows.processing, valid).step).toBe('processing');
  });

  it('does not override a non-transport failure', () => {
    expect(view(failed({ code: 'session_expired' }), valid).step).toBe('failed');
  });

  it.each(['stale', 'expired', 'none', 'policy_mismatch'] as const)(
    'ignores a %s credential',
    (status) => {
      expect(view(flows.wallet, credentialRecord(status)).step).toBe('wallet');
      expect(view(failed({ code: 'timeout' }), credentialRecord(status)).step).toBe('recovering');
    },
  );

  it('treats the flow loan step as a stream result', () => {
    const loan: FlowState = {
      step: 'loan',
      wallet,
      tier: 'A',
      attestation: POOL_0,
      tx: 'sig',
      payloadHex: flows.result.payloadHex,
      loan: 'open',
    };
    expect(view(loan).step).toBe('confirming');
    expect(view(loan, confirmed)).toMatchObject({ step: 'result', source: 'stream', tx: 'sig' });
  });
});

describe('borrowView confirms a stream result against the chain record', () => {
  it('keeps confirming while the chain still shows an earlier attestation', () => {
    const earlier = credentialRecord('valid', { payload: { tier: 1, issuedAt: ISSUED_AT - 500n } });
    expect(view(flows.result, earlier).step).toBe('confirming');
  });

  it('fails, rather than waits, for a reported payload it cannot decode', () => {
    const broken: FlowState = { ...flows.result, payloadHex: 'zz' };
    expect(view(broken, confirmed)).toEqual({ step: 'failed', error: { code: 'protocol_error' } });
  });
});

describe('borrowView failures before and after the intent was sent', () => {
  it.each(['network', 'timeout', 'rpc_busy'] as const)(
    'shows a %s failure before sending as a plain failure, never as recovering',
    (code) => {
      expect(view(failed({ code }, false))).toEqual({ step: 'failed', error: { code } });
      expect(view(failed({ code }, false), valid).step).toBe('failed');
    },
  );

  it('recovers only after sending', () => {
    expect(isRecoverable(failed({ code: 'network' }, true))).toBe(true);
    expect(isRecoverable(failed({ code: 'network' }, false))).toBe(false);
    expect(isRecoverable(failed({ code: 'session_expired' }, true))).toBe(false);
    expect(isRecoverable(flows.processing)).toBe(false);
  });
});

const pollInput = (flow: FlowState, credential?: ReturnType<typeof credentialRecord>) => ({
  flow,
  credential,
  attestation: ATTESTATION,
  replacedIssuedAt: null,
});

describe('shouldPollCredential', () => {
  it('polls a stream result until the chain shows the same attestation', () => {
    expect(shouldPollCredential(pollInput(flows.result))).toBe(true);
    const earlier = credentialRecord('valid', { payload: { issuedAt: ISSUED_AT - 1n } });
    expect(shouldPollCredential(pollInput(flows.result, earlier))).toBe(true);
    expect(shouldPollCredential(pollInput(flows.result, confirmed))).toBe(false);
    // A contradicting record ends the wait too: the view fails instead.
    expect(shouldPollCredential(pollInput(flows.result, valid))).toBe(false);
  });

  it('polls a dropped stream until a valid tier lands, then stops', () => {
    const dropped = failed({ code: 'network' });
    expect(shouldPollCredential(pollInput(dropped, credentialRecord('none')))).toBe(true);
    expect(shouldPollCredential(pollInput(dropped, valid))).toBe(false);
    // This pool refusing the new tier is no reason to keep polling: it landed.
    const refused = credentialRecord('tier_not_accepted', { payload: { tier: 3 } });
    expect(shouldPollCredential(pollInput(dropped, refused))).toBe(false);
  });

  it.each([
    ['wallet', flows.wallet],
    ['processing', flows.processing],
    ['rejected', flows.rejected],
    ['a failure before sending', failed({ code: 'network' }, false)],
  ])('does not poll at %s', (_, flow) => {
    expect(shouldPollCredential(pollInput(flow))).toBe(false);
  });
});

describe('expireConsent', () => {
  const consent = view(flows.consent);

  it('turns consent at 0 s into the session_expired failure', () => {
    expect(expireConsent(consent, 0)).toEqual({
      step: 'failed',
      error: { code: 'session_expired' },
    });
  });

  it('leaves consent with time left, and every other view, alone', () => {
    expect(expireConsent(consent, 1)).toBe(consent);
    expect(expireConsent({ step: 'wallet' }, 0)).toEqual({ step: 'wallet' });
  });
});

describe('borrowView after "Attest again" (replacedIssuedAt)', () => {
  const old = credentialRecord('valid', { payload: { tier: 1, issuedAt: ISSUED_AT } });
  const newer = credentialRecord('valid', { payload: { tier: 2, issuedAt: ISSUED_AT + 10n } });

  it('does not let the replaced tier skip the new flow', () => {
    expect(view(flows.wallet, old, ISSUED_AT).step).toBe('wallet');
    expect(view(flows.persona, old, ISSUED_AT).step).toBe('persona');
  });

  it('keeps waiting on a dropped stream until a newer tier lands', () => {
    const dropped = failed({ code: 'network' });
    expect(view(dropped, old, ISSUED_AT)).toEqual({ step: 'recovering' });
    expect(view(dropped, newer, ISSUED_AT)).toMatchObject({ source: 'chain', tier: 'B' });
  });
});

const pool = (poolId: number, record: ReturnType<typeof credentialRecord>) => ({
  poolId,
  record,
});

describe('acceptingPools', () => {
  const result = view(flows.result, confirmed);

  it('lists the pools whose read shows this attestation and lends to its tier', () => {
    const zero = credentialRecord('tier_not_accepted', { limit: 0n, payload: { tier: 2 } });
    expect(
      acceptingPools(result, [
        pool(0, credentialRecord('valid', { limit: 7n, payload: { tier: 2 } })),
        pool(1, zero),
      ]),
    ).toEqual([{ poolId: 0, limit: 7n }]);
  });

  it('is null while any pool read still shows another attestation or is missing', () => {
    const earlier = credentialRecord('valid', { limit: 9n, payload: { issuedAt: ISSUED_AT - 1n } });
    expect(acceptingPools(result, [pool(0, confirmed), pool(1, earlier)])).toBeNull();
    expect(acceptingPools(result, [pool(0, confirmed), undefined])).toBeNull();
  });

  it('is null outside a result', () => {
    const outside: BorrowView = { step: 'rejected' };
    expect(acceptingPools(outside, [pool(0, valid)])).toBeNull();
  });
});

describe('isTransportFailure', () => {
  it.each([
    ['network', true],
    ['timeout', true],
    ['rpc_busy', true],
    ['session_expired', false],
    ['protocol_error', false],
  ] as const)('%s -> %s', (code, expected) => {
    expect(isTransportFailure({ code })).toBe(expected);
  });
});

describe('confirmationEpoch', () => {
  it('is the reported payload for a stream result, so a new result reads afresh', () => {
    expect(confirmationEpoch(flows.result)).toBe(flows.result.payloadHex);
  });

  it.each([flows.wallet, flows.processing, flows.rejected])('is undefined otherwise', (flow) => {
    expect(confirmationEpoch(flow)).toBeUndefined();
  });
});
