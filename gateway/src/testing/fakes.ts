// Test code only. Fake enclave, bank, relayer and FIU-key manager around the REAL session
// store, with one ordered event log so tests can assert the exact call/stage order.
import type { Deps } from '../flow.ts';
import { createSessionStore } from '../sessions.ts';

export const WALLET = '3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND';
export const SESSION_ID = '2f1c2a52-9d7e-4e86-8b3a-0c4b3d9c1a11';
export const CONSENT_JWS = 'eyJhbGciOiJSUzI1NiJ9.eyJjb25zZW50Ijoib2sifQ.c2lnbmF0dXJl';
export const FI_REQUEST_BODY = new TextEncoder().encode('{"ver":"1.1.3",  "FIDataRange":{ }}');
export const FI_REQUEST_JWS = 'eyJraWQiOiJmaXUifQ..ZmlqcwsZ';
export const FETCH_BYTES = new TextEncoder().encode('{"ver":"1.1.3",\n  "FI":[ ]}');
export const FETCH_JWS = 'eyJraWQiOiJhYSJ9..ZmV0Y2g';
export const POLICY = { v: 2, tiers: [] };
export const NOW0 = 1_790_000_000;

export const TIER_RESULT = {
  tier: 'A' as const,
  payload_hex: 'ab'.repeat(83),
  signature_hex: 'cd'.repeat(65),
  expiry: NOW0 + 600,
};
export const SUBMITTED = {
  tx: '5'.repeat(88),
  attestation: 'AttestationPda1111111111111111111111111111111',
};

export type EvaluateResult =
  | { tier: 'A' | 'B' | 'C'; payload_hex: string; signature_hex: string; expiry: number }
  | { tier: 'REJECT' };

export type Overrides = {
  enclave?: Partial<Deps['enclave']>;
  bank?: Partial<Deps['bank']>;
  relayer?: Partial<Deps['relayer']>;
  fiuKey?: Partial<Deps['fiuKey']>;
  evaluate?: EvaluateResult;
  cap?: number;
  ttlSecs?: number;
};

export type FakeWorld = {
  deps: Deps;
  /** Every call, in order: `fiuKey.ensureFresh`, `bank.consent`, ... */
  log: string[];
  clock: { t: number };
  args: {
    consent: string[];
    enclaveCreate: unknown[];
    enclaveBind: { id: string; body: unknown }[];
    fiRequest: { body: Uint8Array; jws: string }[];
    fiFetch: unknown[];
    enclaveEvaluate: { id: string; body: unknown }[];
    submit: unknown[];
  };
  markStaleCalls: { count: number };
};

/** Wraps `fn` so each call appends `name` to `log` first. */
function logged<A extends unknown[], R>(
  log: string[],
  name: string,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args) => {
    log.push(name);
    return fn(...args);
  };
}

export function fakeWorld(over: Overrides = {}): FakeWorld {
  const log: string[] = [];
  const clock = { t: NOW0 };
  const markStaleCalls = { count: 0 };
  const args: FakeWorld['args'] = {
    consent: [],
    enclaveCreate: [],
    enclaveBind: [],
    fiRequest: [],
    fiFetch: [],
    enclaveEvaluate: [],
    submit: [],
  };
  const result: EvaluateResult = over.evaluate ?? TIER_RESULT;

  const enclave: Deps['enclave'] = {
    info: async () => ({
      app_version: '0.0.0',
      attester_address: '0x' + 'bb'.repeat(20),
      fiu_public_jwk: { kid: 'fiu-1', kty: 'RSA', e: 'AQAB', n: 'abc' },
      fiu_key_signature_hex: '00'.repeat(65),
      pinned_kids: ['aa-1', 'fip-1'],
    }),
    createSession: async (body) => {
      args.enclaveCreate.push(body);
      return {
        session_id: SESSION_ID,
        key_material: {},
        fi_request_body_b64: Buffer.from(FI_REQUEST_BODY).toString('base64'),
        fi_request_jws: FI_REQUEST_JWS,
        intent: 'tee-income-oracle: bind session\nsession: x',
        intent_expires: clock.t + 600,
      };
    },
    bind: async (id, body) => {
      args.enclaveBind.push({ id, body });
      return { status: 'bound' as const };
    },
    evaluate: async (id, body) => {
      args.enclaveEvaluate.push({ id, body });
      return result;
    },
    ...over.enclave,
  };
  const bank: Deps['bank'] = {
    registerFiuKey: async () => ({ kid: 'fiu-1', attester: '0x' + 'bb'.repeat(20) }),
    consent: async (personaId) => {
      args.consent.push(personaId);
      return {
        ver: '1.1.3',
        timestamp: '2026-10-07T10:00:00.000Z',
        consentId: 'consent-1',
        signedConsent: CONSENT_JWS,
      };
    },
    fiRequest: async (body, jws) => {
      args.fiRequest.push({ body, jws });
      return {
        ver: '1.1.3',
        timestamp: '2026-10-07T10:00:01.000Z',
        txnid: 'txn-1',
        consentId: 'consent-1',
        sessionId: 'bank-session-1',
      };
    },
    fiFetch: async (request) => {
      args.fiFetch.push(request);
      return { bytes: FETCH_BYTES, jws: FETCH_JWS };
    },
    ...over.bank,
  };
  const relayer: Deps['relayer'] = {
    submit: async (a) => {
      args.submit.push(a);
      return SUBMITTED;
    },
    ...over.relayer,
  };
  const fiuKey: Pick<Deps['fiuKey'], 'ensureFresh'> = {
    ensureFresh: async () => {},
    ...over.fiuKey,
  };

  const deps: Deps = {
    enclave: {
      ...enclave,
      createSession: logged(log, 'enclave.createSession', enclave.createSession),
      bind: logged(log, 'enclave.bind', enclave.bind),
      evaluate: logged(log, 'enclave.evaluate', enclave.evaluate),
    },
    bank: {
      ...bank,
      consent: logged(log, 'bank.consent', bank.consent),
      fiRequest: logged(log, 'bank.fiRequest', bank.fiRequest),
      fiFetch: logged(log, 'bank.fiFetch', bank.fiFetch),
    },
    relayer: { submit: logged(log, 'relayer.submit', relayer.submit) },
    sessions: createSessionStore({
      now: () => clock.t,
      ...(over.cap === undefined ? {} : { cap: over.cap }),
      ...(over.ttlSecs === undefined ? {} : { ttlSecs: over.ttlSecs }),
    }),
    fiuKey: {
      ...fiuKey,
      ensureFresh: logged(log, 'fiuKey.ensureFresh', fiuKey.ensureFresh),
      markStale: () => {
        markStaleCalls.count += 1;
      },
    },
    policy: POLICY,
    measurementId: 0,
    now: () => clock.t,
  };
  return { deps, log, clock, args, markStaleCalls };
}
