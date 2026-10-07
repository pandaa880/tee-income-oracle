/**
 * The session flow (ARCHITECTURE §4), over injected clients so it is tested
 * without a network. The gateway only carries bytes: the FI request and the
 * fetch response travel exactly as signed, and the tier comes back signed by
 * the enclave. Stages are emitted as each one starts (FORMATS §16).
 */
import { GatewayError } from './errors.ts';
import type { FiuKeyManager } from './fiu-key.ts';
import type { SessionData, SessionStore } from './sessions.ts';
import type { BankClient, EnclaveClient } from './upstream.ts';

export type Stage = 'bind' | 'fi_request' | 'fi_fetch' | 'evaluate' | 'submit';

export type Relayer = {
  submit: (a: {
    wallet: string;
    payloadHex: string;
    signatureHex: string;
    expiry: number;
  }) => Promise<{ tx: string | null; attestation: string }>;
};

export type Deps = {
  enclave: EnclaveClient;
  bank: BankClient;
  relayer: Relayer;
  sessions: SessionStore;
  fiuKey: FiuKeyManager;
  policy: unknown;
  measurementId: number;
  now: () => number;
};

export type CreateRequest = { wallet: string; persona_id: string };
export type CreateResponse = { session_id: string; intent: string; intent_expires: number };
export type CompleteRequest = { signature_b58: string };
export type CompleteResult =
  | {
      tier: 'A' | 'B' | 'C';
      /** null: the payload was already on chain from an earlier transaction. */
      tx: string | null;
      attestation: string;
      expiry: number;
      payload_hex: string;
    }
  | { tier: 'REJECT' };
export type TakenSession = SessionData & { id: string };

export async function createSession(deps: Deps, req: CreateRequest): Promise<CreateResponse> {
  await deps.fiuKey.ensureFresh();
  const consent = await deps.bank.consent(req.persona_id);
  const created = await deps.enclave.createSession({
    policy: deps.policy,
    wallet: req.wallet,
    consent_jws: consent.signedConsent,
    measurement_id: deps.measurementId,
  });
  deps.sessions.put(created.session_id, {
    consentJws: consent.signedConsent,
    wallet: req.wallet,
    fiRequestBodyB64: created.fi_request_body_b64,
    fiRequestJws: created.fi_request_jws,
  });
  return {
    session_id: created.session_id,
    intent: created.intent,
    intent_expires: created.intent_expires,
  };
}

/** Removes the session (single use); throws the pre-stream errors (404 / 410). */
export function takeSession(deps: Deps, id: string): TakenSession {
  return { id, ...deps.sessions.take(id) };
}

async function sendFiRequest(deps: Deps, s: TakenSession) {
  try {
    return await deps.bank.fiRequest(
      new Uint8Array(Buffer.from(s.fiRequestBodyB64, 'base64')),
      s.fiRequestJws,
    );
  } catch (e) {
    // The bank no longer knows our FIU key (bank restart): register it again next time.
    if (e instanceof GatewayError && e.code === 'SignatureDoesNotMatch') deps.fiuKey.markStale();
    throw e;
  }
}

export async function runSession(
  deps: Deps,
  s: TakenSession,
  req: CompleteRequest,
  emit: (stage: Stage) => void,
): Promise<CompleteResult> {
  emit('bind');
  await deps.enclave.bind(s.id, { wallet: s.wallet, signature_b58: req.signature_b58 });
  emit('fi_request');
  const ack = await sendFiRequest(deps, s);
  emit('fi_fetch');
  const fetched = await deps.bank.fiFetch({ txnid: ack.txnid, sessionId: ack.sessionId });
  emit('evaluate');
  const result = await deps.enclave.evaluate(s.id, {
    fetch_response_b64: Buffer.from(fetched.bytes).toString('base64'),
    fetch_response_jws: fetched.jws,
    consent_jws: s.consentJws,
  });
  if (result.tier === 'REJECT') return { tier: 'REJECT' };
  emit('submit');
  const submitted = await deps.relayer.submit({
    wallet: s.wallet,
    payloadHex: result.payload_hex,
    signatureHex: result.signature_hex,
    expiry: result.expiry,
  });
  return {
    tier: result.tier,
    ...submitted,
    expiry: result.expiry,
    payload_hex: result.payload_hex,
  };
}

export async function completeSession(
  deps: Deps,
  id: string,
  req: CompleteRequest,
  emit: (stage: Stage) => void,
): Promise<CompleteResult> {
  return runSession(deps, takeSession(deps, id), req, emit);
}
