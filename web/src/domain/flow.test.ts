import { describe, expect, it } from 'vitest';
import { flowReducer, initialFlowState, type FlowAction, type FlowState } from './flow.ts';
import type { FlowEvent, Session } from './types.ts';
import { ADMIN, OTHER, POOL_0 } from '../test-support/fixtures.ts';

const SESSION: Session = { sessionId: 's-1', intent: 'intent text', intentExpires: 1_790_000_600n };
const RESULT_EVENT: FlowEvent = {
  kind: 'result',
  result: { tier: 'B', tx: 'sig', attestation: POOL_0, expiry: 99n, payloadHex: '00' },
};
const stage = (name: 'bind' | 'fi_request' | 'fi_fetch' | 'evaluate' | 'submit'): FlowAction => ({
  type: 'event',
  event: { kind: 'stage', stage: name },
});

const run = (...actions: FlowAction[]): FlowState => actions.reduce(flowReducer, initialFlowState);

/** The §16 stages a tier result follows, and the four a REJECT follows (no submit). */
const TIER_STAGES = (['bind', 'fi_request', 'fi_fetch', 'evaluate', 'submit'] as const).map(stage);
const REJECT_STAGES = TIER_STAGES.slice(0, 4);
const REJECT_EVENT: FlowAction = {
  type: 'event',
  event: { kind: 'result', result: { tier: 'REJECT' } },
};

const connect: FlowAction = { type: 'connect', wallet: ADMIN };
const session: FlowAction = {
  type: 'session_created',
  persona: 'salaried_steady',
  session: SESSION,
};
const consent: FlowAction = { type: 'consent_given' };

describe('flowReducer happy path', () => {
  it('starts at the wallet step', () => {
    expect(initialFlowState.step).toBe('wallet');
  });

  it('connect moves wallet -> persona and remembers the wallet', () => {
    expect(run(connect)).toMatchObject({ step: 'persona', wallet: ADMIN });
  });

  it('session_created moves persona -> consent with the session', () => {
    expect(run(connect, session)).toMatchObject({
      step: 'consent',
      wallet: ADMIN,
      persona: 'salaried_steady',
      session: SESSION,
    });
  });

  it('consent_given starts processing with no stages yet', () => {
    expect(run(connect, session, consent)).toMatchObject({ step: 'processing', stages: [] });
  });

  it('records stages in the order received', () => {
    const state = run(connect, session, consent, stage('bind'), stage('fi_request'));
    expect(state).toMatchObject({ step: 'processing', stages: ['bind', 'fi_request'] });
  });

  it('a result event ends processing with tier, attestation and tx', () => {
    const state = run(connect, session, consent, ...TIER_STAGES, {
      type: 'event',
      event: RESULT_EVENT,
    });
    expect(state).toMatchObject({ step: 'result', tier: 'B', attestation: POOL_0, tx: 'sig' });
  });

  it('a REJECT result ends in rejected', () => {
    const state = run(connect, session, consent, ...REJECT_STAGES, REJECT_EVENT);
    expect(state.step).toBe('rejected');
  });

  it('an error event while processing ends in failed with that error', () => {
    const state = run(connect, session, consent, stage('bind'), {
      type: 'event',
      event: { kind: 'error', error: { code: 'stale_attestation' } },
    });
    expect(state).toMatchObject({ step: 'failed', error: { code: 'stale_attestation' } });
  });

  it('a failed action (for example session creation failing) ends in failed', () => {
    expect(run(connect, { type: 'failed', error: { code: 'rate_limited' } })).toMatchObject({
      step: 'failed',
      error: { code: 'rate_limited' },
    });
  });

  it('after a result, loan_opened then loan_repaid walk the loan states', () => {
    const result = run(connect, session, consent, ...TIER_STAGES, {
      type: 'event',
      event: RESULT_EVENT,
    });
    const open = flowReducer(result, { type: 'loan_opened' });
    expect(open).toMatchObject({ step: 'loan', loan: 'open' });
    expect(flowReducer(open, { type: 'loan_repaid' })).toMatchObject({
      step: 'loan',
      loan: 'repaid',
    });
  });

  it('reset returns to the wallet step from anywhere', () => {
    const failed = run(connect, { type: 'failed', error: { code: 'network' } });
    expect(flowReducer(failed, { type: 'reset' })).toEqual(initialFlowState);
  });
});

describe('flowReducer wallet change', () => {
  const other: FlowAction = { type: 'connect', wallet: OTHER };

  it.each([
    ['persona', [connect]],
    ['consent', [connect, session]],
    ['processing', [connect, session, consent, stage('bind')]],
    [
      'result',
      [
        connect,
        session,
        consent,
        ...TIER_STAGES,
        { type: 'event', event: RESULT_EVENT } satisfies FlowAction,
      ],
    ],
  ])(
    'a different wallet resets %s to persona for the new wallet, dropping the old data',
    (_, actions) => {
      const state = actions.reduce(flowReducer, initialFlowState);
      const next = flowReducer(state, other);
      expect(next).toEqual({ step: 'persona', wallet: OTHER });
    },
  );

  it('a different wallet also resets rejected, failed and loan', () => {
    const rejected = run(connect, session, consent, ...REJECT_STAGES, REJECT_EVENT);
    const failed = run(connect, { type: 'failed', error: { code: 'network' } });
    const loan = flowReducer(
      run(connect, session, consent, ...TIER_STAGES, { type: 'event', event: RESULT_EVENT }),
      { type: 'loan_opened' },
    );
    for (const state of [rejected, failed, loan]) {
      expect(flowReducer(state, other)).toEqual({ step: 'persona', wallet: OTHER });
    }
  });

  it('connecting the same wallet again changes nothing', () => {
    const state = run(connect, session);
    expect(flowReducer(state, connect)).toBe(state);
  });
});

describe('flowReducer ignores impossible transitions', () => {
  const nothingElse: [string, FlowState, FlowAction][] = [
    ['session_created at the wallet step', initialFlowState, session],
    ['consent_given at the wallet step', initialFlowState, consent],
    ['consent_given at the persona step', run(connect), consent],
    ['a stage event at the consent step', run(connect, session), stage('bind')],
    ['a result event at the persona step', run(connect), { type: 'event', event: RESULT_EVENT }],
    ['loan_opened before a result', run(connect, session, consent), { type: 'loan_opened' }],
    [
      'loan_repaid without an open loan',
      run(connect, session, consent, ...TIER_STAGES, { type: 'event', event: RESULT_EVENT }),
      { type: 'loan_repaid' },
    ],
    ['session_created while processing', run(connect, session, consent), session],
    [
      'a stage event after the result',
      run(connect, session, consent, ...TIER_STAGES, { type: 'event', event: RESULT_EVENT }),
      stage('submit'),
    ],
    [
      'a failed action at the wallet step',
      initialFlowState,
      { type: 'failed', error: { code: 'network' } },
    ],
  ];

  it.each(nothingElse)('%s returns the same state object', (_, state, action) => {
    expect(flowReducer(state, action)).toBe(state);
  });
});

const processing = (...stages: FlowAction[]) => run(connect, session, consent, ...stages);

describe('flowReducer enforces the FORMATS §16 stage order', () => {
  const broken = { step: 'failed', error: { code: 'protocol_error' } };

  it('fails on a skipped stage', () => {
    expect(processing(stage('bind'), stage('fi_fetch'))).toMatchObject(broken);
  });

  it('fails on a duplicate stage', () => {
    expect(processing(stage('bind'), stage('bind'))).toMatchObject(broken);
  });

  it('fails on a stage that does not start the stream', () => {
    expect(processing(stage('fi_request'))).toMatchObject(broken);
  });

  it('fails on a tier result before submit', () => {
    expect(processing(...REJECT_STAGES, { type: 'event', event: RESULT_EVENT })).toMatchObject(
      broken,
    );
  });

  it('fails on a REJECT after submit (a REJECT never submits)', () => {
    expect(processing(...TIER_STAGES, REJECT_EVENT)).toMatchObject(broken);
  });

  it('fails on a stage after submit', () => {
    expect(processing(...TIER_STAGES, stage('bind'))).toMatchObject(broken);
  });
});
