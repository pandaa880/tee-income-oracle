import { describe, expect, it } from 'vitest';

import { completeSession, createSession, runSession, takeSession } from './flow.ts';
import { gatewayError } from './errors.ts';
import {
  CONSENT_JWS,
  FETCH_BYTES,
  FETCH_JWS,
  FI_REQUEST_BODY,
  FI_REQUEST_JWS,
  POLICY,
  SESSION_ID,
  SUBMITTED,
  TIER_RESULT,
  WALLET,
  fakeWorld,
  type Overrides,
} from './testing/fakes.ts';
import { expectRejected } from './testing/expect-rejected.ts';

const CREATE = { wallet: WALLET, persona_id: 'salaried_steady' } as const;
const SIGNED = { signature_b58: 'sigSigSig' };

type Stage = Parameters<Parameters<typeof completeSession>[3]>[0];

/** A created session in a fresh world; `emitted` collects stages and interleaves them into `log`. */
async function created(over: Overrides = {}) {
  const w = fakeWorld(over);
  const res = await createSession(w.deps, CREATE);
  w.log.length = 0;
  const emitted: Stage[] = [];
  const emit = (stage: Stage) => {
    emitted.push(stage);
    w.log.push(`emit:${stage}`);
  };
  return { w, res, emitted, emit };
}

describe('createSession', () => {
  it('runs fiuKey.ensureFresh, bank.consent, enclave.createSession in that order', async () => {
    const w = fakeWorld();
    await createSession(w.deps, CREATE);
    expect(w.log).toEqual(['fiuKey.ensureFresh', 'bank.consent', 'enclave.createSession']);
  });

  it('returns exactly session_id, intent and intent_expires', async () => {
    const w = fakeWorld();
    const res = await createSession(w.deps, CREATE);
    expect(Object.keys(res).toSorted()).toEqual(['intent', 'intent_expires', 'session_id']);
    expect(res.session_id).toBe(SESSION_ID);
    expect(res.intent_expires).toBeGreaterThan(w.clock.t);
  });

  it('asks the bank for the persona consent', async () => {
    const w = fakeWorld();
    await createSession(w.deps, { wallet: WALLET, persona_id: 'declining' });
    expect(w.args.consent).toEqual(['declining']);
  });

  it('creates the enclave session with policy, wallet, the signed consent and the measurement id', async () => {
    const w = fakeWorld();
    await createSession(w.deps, CREATE);
    expect(w.args.enclaveCreate).toEqual([
      { policy: POLICY, wallet: WALLET, consent_jws: CONSENT_JWS, measurement_id: 0 },
    ]);
  });

  it('stores the session under the enclave session id', async () => {
    const w = fakeWorld();
    await createSession(w.deps, CREATE);
    expect(w.deps.sessions.size()).toBe(1);
    const taken = w.deps.sessions.take(SESSION_ID);
    expect(taken.consentJws).toBe(CONSENT_JWS);
    expect(taken.wallet).toBe(WALLET);
  });

  it('stops before the bank when the FIU key check fails (enclave_rotated)', async () => {
    const w = fakeWorld({
      fiuKey: {
        ensureFresh: async () => {
          throw gatewayError('enclave_rotated', 'enclave', 503);
        },
      },
    });
    await expectRejected(createSession(w.deps, CREATE), {
      code: 'enclave_rotated',
      stage: 'enclave',
      status: 503,
    });
    expect(w.log).toEqual(['fiuKey.ensureFresh']);
    expect(w.deps.sessions.size()).toBe(0);
  });

  it('passes a bank consent failure through and never reaches the enclave', async () => {
    const w = fakeWorld({
      bank: {
        consent: async () => {
          throw gatewayError('upstream_unavailable', 'bank', 502);
        },
      },
    });
    await expectRejected(createSession(w.deps, CREATE), {
      code: 'upstream_unavailable',
      stage: 'bank',
      status: 502,
    });
    expect(w.args.enclaveCreate).toEqual([]);
    expect(w.deps.sessions.size()).toBe(0);
  });

  it('passes an enclave create failure through and stores nothing', async () => {
    const w = fakeWorld({
      enclave: {
        createSession: async () => {
          throw gatewayError('consent_invalid', 'enclave', 422);
        },
      },
    });
    await expectRejected(createSession(w.deps, CREATE), {
      code: 'consent_invalid',
      stage: 'enclave',
      status: 422,
    });
    expect(w.deps.sessions.size()).toBe(0);
  });

  it('answers too_many_sessions 503 when the store is full', async () => {
    const w = fakeWorld({ cap: 1 });
    await createSession(w.deps, CREATE);
    await expectRejected(createSession(w.deps, CREATE), {
      code: 'too_many_sessions',
      stage: 'gateway',
      status: 503,
    });
  });
});

describe('completeSession: happy path', () => {
  it('emits the stages and calls upstream in the exact order for a tier', async () => {
    const { w, res, emit } = await created();
    await completeSession(w.deps, res.session_id, SIGNED, emit);
    expect(w.log).toEqual([
      'emit:bind',
      'enclave.bind',
      'emit:fi_request',
      'bank.fiRequest',
      'emit:fi_fetch',
      'bank.fiFetch',
      'emit:evaluate',
      'enclave.evaluate',
      'emit:submit',
      'relayer.submit',
    ]);
  });

  it('returns tier, tx, attestation, expiry and payload_hex', async () => {
    const { w, res, emit } = await created();
    expect(await completeSession(w.deps, res.session_id, SIGNED, emit)).toEqual({
      tier: 'A',
      tx: SUBMITTED.tx,
      attestation: SUBMITTED.attestation,
      expiry: TIER_RESULT.expiry,
      payload_hex: TIER_RESULT.payload_hex,
    });
  });

  it.each(['B', 'C'] as const)('carries tier %s through', async (tier) => {
    const { w, res, emit } = await created({ evaluate: { ...TIER_RESULT, tier } });
    const result = await completeSession(w.deps, res.session_id, SIGNED, emit);
    expect(result.tier).toBe(tier);
  });

  it('binds with the stored wallet and the borrower signature on the enclave session', async () => {
    const { w, res, emit } = await created();
    await completeSession(w.deps, res.session_id, SIGNED, emit);
    expect(w.args.enclaveBind).toEqual([
      { id: SESSION_ID, body: { wallet: WALLET, signature_b58: SIGNED.signature_b58 } },
    ]);
  });

  it("sends the enclave's FI request bytes (decoded) and JWS to the bank verbatim", async () => {
    const { w, res, emit } = await created();
    await completeSession(w.deps, res.session_id, SIGNED, emit);
    expect(w.args.fiRequest).toHaveLength(1);
    expect(w.args.fiRequest[0]?.body).toEqual(FI_REQUEST_BODY);
    expect(w.args.fiRequest[0]?.jws).toBe(FI_REQUEST_JWS);
  });

  it("fetches with the bank's txnid and sessionId", async () => {
    const { w, res, emit } = await created();
    await completeSession(w.deps, res.session_id, SIGNED, emit);
    expect(w.args.fiFetch).toEqual([{ txnid: 'txn-1', sessionId: 'bank-session-1' }]);
  });

  it('evaluates with base64 of the exact fetched bytes, the fetch JWS and the signed consent', async () => {
    const { w, res, emit } = await created();
    await completeSession(w.deps, res.session_id, SIGNED, emit);
    expect(w.args.enclaveEvaluate).toEqual([
      {
        id: SESSION_ID,
        body: {
          fetch_response_b64: Buffer.from(FETCH_BYTES).toString('base64'),
          fetch_response_jws: FETCH_JWS,
          consent_jws: CONSENT_JWS,
        },
      },
    ]);
  });

  it("submits the enclave's payload, signature and expiry for the session wallet", async () => {
    const { w, res, emit } = await created();
    await completeSession(w.deps, res.session_id, SIGNED, emit);
    expect(w.args.submit).toEqual([
      {
        wallet: WALLET,
        payloadHex: TIER_RESULT.payload_hex,
        signatureHex: TIER_RESULT.signature_hex,
        expiry: TIER_RESULT.expiry,
      },
    ]);
  });
});

describe('completeSession: REJECT', () => {
  it('returns { tier: REJECT }, never calls the relayer and never emits submit', async () => {
    const { w, res, emit, emitted } = await created({ evaluate: { tier: 'REJECT' } });
    expect(await completeSession(w.deps, res.session_id, SIGNED, emit)).toEqual({ tier: 'REJECT' });
    expect(w.args.submit).toEqual([]);
    expect(emitted).toEqual(['bind', 'fi_request', 'fi_fetch', 'evaluate']);
  });
});

describe('completeSession: each upstream failure carries its stage and stops the flow', () => {
  it('enclave bind failure (bad_intent_signature)', async () => {
    const { w, res, emit, emitted } = await created({
      enclave: {
        bind: async () => {
          throw gatewayError('bad_intent_signature', 'enclave', 401);
        },
      },
    });
    await expectRejected(completeSession(w.deps, res.session_id, SIGNED, emit), {
      code: 'bad_intent_signature',
      stage: 'enclave',
      status: 401,
    });
    expect(emitted).toEqual(['bind']);
    expect(w.args.fiRequest).toEqual([]);
  });

  it('bank FI request failure', async () => {
    const { w, res, emit, emitted } = await created({
      bank: {
        fiRequest: async () => {
          throw gatewayError('InvalidConsentUse', 'bank', 400);
        },
      },
    });
    await expectRejected(completeSession(w.deps, res.session_id, SIGNED, emit), {
      code: 'InvalidConsentUse',
      stage: 'bank',
      status: 400,
    });
    expect(emitted).toEqual(['bind', 'fi_request']);
    expect(w.args.fiFetch).toEqual([]);
  });

  it('bank FI fetch failure', async () => {
    const { w, res, emit, emitted } = await created({
      bank: {
        fiFetch: async () => {
          throw gatewayError('DataGone', 'bank', 410);
        },
      },
    });
    await expectRejected(completeSession(w.deps, res.session_id, SIGNED, emit), {
      code: 'DataGone',
      stage: 'bank',
      status: 410,
    });
    expect(emitted).toEqual(['bind', 'fi_request', 'fi_fetch']);
    expect(w.args.enclaveEvaluate).toEqual([]);
  });

  it('enclave evaluate failure', async () => {
    const { w, res, emit, emitted } = await created({
      enclave: {
        evaluate: async () => {
          throw gatewayError('bad_aa_signature', 'enclave', 422);
        },
      },
    });
    await expectRejected(completeSession(w.deps, res.session_id, SIGNED, emit), {
      code: 'bad_aa_signature',
      stage: 'enclave',
      status: 422,
    });
    expect(emitted).toEqual(['bind', 'fi_request', 'fi_fetch', 'evaluate']);
    expect(w.args.submit).toEqual([]);
  });

  it('relayer failure (stale_attestation on chain)', async () => {
    const { w, res, emit, emitted } = await created({
      relayer: {
        submit: async () => {
          throw gatewayError('stale_attestation', 'chain', 409);
        },
      },
    });
    await expectRejected(completeSession(w.deps, res.session_id, SIGNED, emit), {
      code: 'stale_attestation',
      stage: 'chain',
      status: 409,
    });
    expect(emitted).toEqual(['bind', 'fi_request', 'fi_fetch', 'evaluate', 'submit']);
  });

  it('a bank SignatureDoesNotMatch on FI request marks the FIU key stale', async () => {
    const { w, res, emit } = await created({
      bank: {
        fiRequest: async () => {
          throw gatewayError('SignatureDoesNotMatch', 'bank', 400);
        },
      },
    });
    await expectRejected(completeSession(w.deps, res.session_id, SIGNED, emit), {
      code: 'SignatureDoesNotMatch',
      stage: 'bank',
    });
    expect(w.markStaleCalls.count).toBe(1);
  });

  it('other bank errors do not mark the FIU key stale', async () => {
    const { w, res, emit } = await created({
      bank: {
        fiRequest: async () => {
          throw gatewayError('InvalidConsentId', 'bank', 400);
        },
      },
    });
    await expectRejected(completeSession(w.deps, res.session_id, SIGNED, emit), {
      code: 'InvalidConsentId',
      stage: 'bank',
    });
    expect(w.markStaleCalls.count).toBe(0);
  });
});

describe('completeSession: session handling', () => {
  it('is single use, even after a failure', async () => {
    const { w, res, emit } = await created({
      enclave: {
        bind: async () => {
          throw gatewayError('bad_intent_signature', 'enclave', 401);
        },
      },
    });
    await expectRejected(completeSession(w.deps, res.session_id, SIGNED, emit), {
      code: 'bad_intent_signature',
      stage: 'enclave',
    });
    await expectRejected(completeSession(w.deps, res.session_id, SIGNED, emit), {
      code: 'session_not_found',
      stage: 'gateway',
      status: 404,
    });
  });

  it('rejects an unknown id before emitting any stage or calling upstream', async () => {
    const { w, emit, emitted } = await created();
    await expectRejected(completeSession(w.deps, 'no-such-id', SIGNED, emit), {
      code: 'session_not_found',
      stage: 'gateway',
      status: 404,
    });
    expect(emitted).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it('rejects an expired session with session_expired 410 before emitting anything', async () => {
    const { w, res, emit, emitted } = await created();
    w.clock.t += 601;
    await expectRejected(completeSession(w.deps, res.session_id, SIGNED, emit), {
      code: 'session_expired',
      stage: 'gateway',
      status: 410,
    });
    expect(emitted).toEqual([]);
    expect(w.log).toEqual([]);
  });
});

describe('takeSession and runSession (the route takes before it opens the stream)', () => {
  it('takeSession throws the pre-stream errors without any emit', async () => {
    const { w } = await created();
    await expectRejected(
      Promise.resolve().then(() => takeSession(w.deps, 'no-such-id')),
      { code: 'session_not_found', stage: 'gateway', status: 404 },
    );
    expect(w.log).toEqual([]);
  });

  it('takeSession throws session_expired 410 for an expired session', async () => {
    const { w, res } = await created();
    w.clock.t += 601;
    await expectRejected(
      Promise.resolve().then(() => takeSession(w.deps, res.session_id)),
      { code: 'session_expired', stage: 'gateway', status: 410 },
    );
  });

  it('takeSession removes the session', async () => {
    const { w, res } = await created();
    const taken = takeSession(w.deps, res.session_id);
    expect(taken.wallet).toBe(WALLET);
    expect(w.deps.sessions.size()).toBe(0);
  });

  it('runSession on a taken session runs the same ordered flow as completeSession', async () => {
    const { w, res, emit } = await created();
    const taken = takeSession(w.deps, res.session_id);
    const result = await runSession(w.deps, taken, SIGNED, emit);
    expect(result.tier).toBe('A');
    expect(w.log.filter((l) => l.startsWith('emit:'))).toEqual([
      'emit:bind',
      'emit:fi_request',
      'emit:fi_fetch',
      'emit:evaluate',
      'emit:submit',
    ]);
  });
});
