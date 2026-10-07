import { describe, expect, it } from 'vitest';

import {
  bytesResponse,
  fakeFetch,
  firstRequest,
  jsonResponse,
  requestJson,
  requestObject,
} from './testing/fake-fetch.ts';
import { expectRejected } from './testing/expect-rejected.ts';
import { createBankClient, createEnclaveClient } from './upstream.ts';

const ENCLAVE = 'http://enclave.internal:8080';
const BANK = 'http://bank.internal:8081';

const INFO = {
  app_version: '0.1.0',
  attester_address: '0x' + 'bb'.repeat(20),
  fiu_public_jwk: { kid: 'fiu-1', kty: 'RSA', e: 'AQAB', n: 'abc' },
  fiu_key_signature_hex: '00'.repeat(65),
  pinned_kids: ['aa-1', 'fip-1'],
};
const CREATED = {
  session_id: '2f1c2a52-9d7e-4e86-8b3a-0c4b3d9c1a11',
  key_material: { Nonce: 'x' },
  fi_request_body_b64: 'e30=',
  fi_request_jws: 'a..b',
  intent: 'tee-income-oracle: bind session',
  intent_expires: 1_790_000_600,
};
const TIER = {
  tier: 'B',
  payload_hex: 'ab'.repeat(83),
  signature_hex: 'cd'.repeat(65),
  expiry: 1_790_000_600,
};
const rebitError = (errorCode: string) => ({
  ver: '1.1.3',
  txnid: '',
  timestamp: '2026-10-07T10:00:00.000Z',
  errorCode,
  errorMsg: 'upstream text that must never be shown',
});
const enclaveError = (code: string) => ({
  error: { code, message: 'upstream text that must never be shown' },
});

describe('enclave client: requests', () => {
  it('info does GET /v1/info and returns the parsed object', async () => {
    const f = fakeFetch(() => jsonResponse(200, INFO));
    const info = await createEnclaveClient(ENCLAVE, f.fetch).info();
    expect(f.requests[0]?.method).toBe('GET');
    expect(f.requests[0]?.url).toBe(`${ENCLAVE}/v1/info`);
    expect(info).toMatchObject({ attester_address: INFO.attester_address });
    expect(info.fiu_public_jwk.kid).toBe('fiu-1');
  });

  it('createSession posts exactly the four members to /v1/sessions as JSON', async () => {
    const f = fakeFetch(() => jsonResponse(200, CREATED));
    const body = { policy: { v: 2 }, wallet: 'W', consent_jws: 'c.o.n', measurement_id: 3 };
    const created = await createEnclaveClient(ENCLAVE, f.fetch).createSession(body);
    expect(f.requests[0]?.method).toBe('POST');
    expect(f.requests[0]?.url).toBe(`${ENCLAVE}/v1/sessions`);
    expect(f.requests[0]?.headers.get('content-type')).toContain('application/json');
    expect(requestJson(firstRequest(f))).toEqual(body);
    expect(created).toMatchObject({
      session_id: CREATED.session_id,
      fi_request_body_b64: CREATED.fi_request_body_b64,
      fi_request_jws: CREATED.fi_request_jws,
      intent: CREATED.intent,
      intent_expires: CREATED.intent_expires,
    });
  });

  it('bind posts wallet and signature to /v1/sessions/{id}/bind', async () => {
    const f = fakeFetch(() => jsonResponse(200, { status: 'bound' }));
    const res = await createEnclaveClient(ENCLAVE, f.fetch).bind('abc', {
      wallet: 'W',
      signature_b58: 'S',
    });
    expect(f.requests[0]?.url).toBe(`${ENCLAVE}/v1/sessions/abc/bind`);
    expect(requestJson(firstRequest(f))).toEqual({ wallet: 'W', signature_b58: 'S' });
    expect(res).toEqual({ status: 'bound' });
  });

  it('evaluate posts the three members to /v1/sessions/{id}/evaluate', async () => {
    const f = fakeFetch(() => jsonResponse(200, TIER));
    const body = { fetch_response_b64: 'e30=', fetch_response_jws: 'a..b', consent_jws: 'c.o.n' };
    await createEnclaveClient(ENCLAVE, f.fetch).evaluate('abc', body);
    expect(f.requests[0]?.url).toBe(`${ENCLAVE}/v1/sessions/abc/evaluate`);
    expect(requestJson(firstRequest(f))).toEqual(body);
  });

  it('passes an AbortSignal (upstream timeout) on every call', async () => {
    const f = fakeFetch(() => jsonResponse(200, { status: 'bound' }));
    await createEnclaveClient(ENCLAVE, f.fetch).bind('abc', { wallet: 'W', signature_b58: 'S' });
    expect(f.requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('enclave client: evaluate results', () => {
  const evalBody = { fetch_response_b64: 'e30=', fetch_response_jws: 'a..b', consent_jws: 'c.o.n' };

  it.each(['A', 'B', 'C'])('returns tier %s with payload, signature and expiry', async (tier) => {
    const f = fakeFetch(() => jsonResponse(200, { ...TIER, tier }));
    expect(await createEnclaveClient(ENCLAVE, f.fetch).evaluate('x', evalBody)).toEqual({
      ...TIER,
      tier,
    });
  });

  it('returns { tier: REJECT } without payload members', async () => {
    const f = fakeFetch(() => jsonResponse(200, { tier: 'REJECT' }));
    expect(await createEnclaveClient(ENCLAVE, f.fetch).evaluate('x', evalBody)).toEqual({
      tier: 'REJECT',
    });
  });

  it.each([
    ['unknown tier', { ...TIER, tier: 'D' }],
    ['tier without payload_hex', { tier: 'A', signature_hex: 'cd', expiry: 1 }],
    ['non-numeric expiry', { ...TIER, expiry: 'soon' }],
    ['payload_hex not 83 bytes', { ...TIER, payload_hex: 'ab'.repeat(82) }],
    ['signature_hex not 65 bytes', { ...TIER, signature_hex: 'cd'.repeat(64) }],
    ['uppercase hex', { ...TIER, payload_hex: 'AB'.repeat(83) }],
    ['empty object', {}],
  ])('rejects a schema mismatch (%s) as upstream_unavailable', async (_name, body) => {
    const f = fakeFetch(() => jsonResponse(200, body));
    await expectRejected(createEnclaveClient(ENCLAVE, f.fetch).evaluate('x', evalBody), {
      code: 'upstream_unavailable',
      stage: 'enclave',
      status: 502,
    });
  });

  it('rejects a response over 64 KiB as upstream_unavailable', async () => {
    const f = fakeFetch(() => jsonResponse(200, { ...TIER, payload_hex: 'ab'.repeat(40_000) }));
    await expectRejected(createEnclaveClient(ENCLAVE, f.fetch).evaluate('x', evalBody), {
      code: 'upstream_unavailable',
      stage: 'enclave',
      status: 502,
    });
  });
});

const enclaveBind = (f: ReturnType<typeof fakeFetch>) =>
  createEnclaveClient(ENCLAVE, f.fetch).bind('abc', { wallet: 'W', signature_b58: 'S' });

describe('enclave client: errors', () => {
  const call = enclaveBind;

  it.each([
    [401, 'bad_intent_signature'],
    [404, 'session_not_found'],
    [410, 'session_expired'],
    [422, 'bad_aa_signature'],
    [409, 'session_not_bound'],
  ])('maps upstream %i %s to the same code, stage enclave, same status', async (status, code) => {
    const f = fakeFetch(() => jsonResponse(status, enclaveError(code)));
    await expectRejected(call(f), { code, stage: 'enclave', status });
  });

  it.each([
    [500, 'internal_error'],
    [503, 'too_many_sessions'],
  ])('keeps the code of an upstream %i and answers 502', async (status, code) => {
    const f = fakeFetch(() => jsonResponse(status, enclaveError(code)));
    await expectRejected(call(f), { code, stage: 'enclave', status: 502 });
  });

  it('turns a network error into upstream_unavailable 502', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expectRejected(call(f), { code: 'upstream_unavailable', stage: 'enclave', status: 502 });
  });

  it('turns a timeout into upstream_unavailable 502', async () => {
    const f = fakeFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expectRejected(call(f), { code: 'upstream_unavailable', stage: 'enclave', status: 502 });
  });

  it('turns a non-JSON success body into upstream_unavailable 502', async () => {
    const f = fakeFetch(() => new Response('<html>oops</html>', { status: 200 }));
    await expectRejected(call(f), { code: 'upstream_unavailable', stage: 'enclave', status: 502 });
  });

  it('turns a non-JSON error body into upstream_unavailable 502', async () => {
    const f = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 400 }));
    await expectRejected(call(f), { code: 'upstream_unavailable', stage: 'enclave', status: 502 });
  });

  it.each([
    ['a newline (log forging)', 'bad_aa_signature\ngateway: session=x code=ok'],
    ['a space', 'bad code'],
    ['over 64 characters', 'a'.repeat(65)],
    ['a leading digit', '1abc'],
  ])('refuses an upstream code with %s as upstream_unavailable', async (_name, code) => {
    const f = fakeFetch(() => jsonResponse(422, enclaveError(code)));
    await expectRejected(call(f), { code: 'upstream_unavailable', stage: 'enclave', status: 502 });
  });

  it('does not carry the upstream message text in the error', async () => {
    const f = fakeFetch(() => jsonResponse(422, enclaveError('bad_aa_signature')));
    const e = await expectRejected(call(f), { code: 'bad_aa_signature', stage: 'enclave' });
    expect(e.message).not.toContain('upstream text that must never be shown');
  });
});

describe('bank client: requests', () => {
  it('registerFiuKey posts the two members to /fiu-keys', async () => {
    const f = fakeFetch(() =>
      jsonResponse(200, { kid: 'fiu-1', attester: '0x' + 'bb'.repeat(20) }),
    );
    const body = { fiu_public_jwk: { kid: 'fiu-1', kty: 'RSA' }, fiu_key_signature_hex: '00' };
    const res = await createBankClient(BANK, f.fetch).registerFiuKey(body);
    expect(f.requests[0]?.url).toBe(`${BANK}/fiu-keys`);
    expect(f.requests[0]?.method).toBe('POST');
    expect(requestJson(firstRequest(f))).toEqual(body);
    expect(res).toMatchObject({ kid: 'fiu-1' });
  });

  it('consent posts { persona_id } to /Consent and returns the signed consent', async () => {
    const reply = {
      ver: '1.1.3',
      timestamp: '2026-10-07T10:00:00.000Z',
      consentId: 'c-1',
      signedConsent: 'a.b.c',
    };
    const f = fakeFetch(() => jsonResponse(200, reply));
    const res = await createBankClient(BANK, f.fetch).consent('salaried_steady');
    expect(f.requests[0]?.url).toBe(`${BANK}/Consent`);
    expect(requestJson(firstRequest(f))).toEqual({ persona_id: 'salaried_steady' });
    expect(res).toMatchObject({ consentId: 'c-1', signedConsent: 'a.b.c' });
  });

  it('fiRequest posts the exact bytes with the x-jws-signature header', async () => {
    const reply = {
      ver: '1.1.3',
      timestamp: 't',
      txnid: 'txn-1',
      consentId: 'c-1',
      sessionId: 's-1',
    };
    const f = fakeFetch(() => jsonResponse(200, reply));
    const bytes = new TextEncoder().encode('{"ver":"1.1.3",   "x":\n[ ]}');
    const res = await createBankClient(BANK, f.fetch).fiRequest(bytes, 'h..sig');
    expect(f.requests[0]?.url).toBe(`${BANK}/FI/request`);
    expect(f.requests[0]?.body).toEqual(bytes);
    expect(f.requests[0]?.headers.get('x-jws-signature')).toBe('h..sig');
    expect(res).toMatchObject({ txnid: 'txn-1', sessionId: 's-1' });
  });

  it('fiFetch posts { ver, timestamp, txnid, sessionId } with ver 1.1.3', async () => {
    const f = fakeFetch(() =>
      bytesResponse(200, new TextEncoder().encode('{"a":1}'), { 'x-jws-signature': 'h..sig' }),
    );
    await createBankClient(BANK, f.fetch).fiFetch({ txnid: 'txn-1', sessionId: 's-1' });
    expect(f.requests[0]?.url).toBe(`${BANK}/FI/fetch`);
    const sent = requestObject(firstRequest(f));
    expect(sent).toMatchObject({ ver: '1.1.3', txnid: 'txn-1', sessionId: 's-1' });
    expect(Object.keys(sent).toSorted()).toEqual(['sessionId', 'timestamp', 'txnid', 'ver']);
    expect(Number.isNaN(Date.parse(String(sent['timestamp'])))).toBe(false);
  });

  it('fiFetch returns the exact response bytes (not re-serialised) and the JWS header', async () => {
    const raw = new TextEncoder().encode('{ "FI" :[ ],\n "z":1 }  ');
    const f = fakeFetch(() => bytesResponse(200, raw, { 'x-jws-signature': 'h..sig' }));
    const res = await createBankClient(BANK, f.fetch).fiFetch({ txnid: 't', sessionId: 's' });
    expect(res.bytes).toEqual(raw);
    expect(res.jws).toBe('h..sig');
  });

  it('fiFetch without x-jws-signature is upstream_unavailable 502 from the bank', async () => {
    const f = fakeFetch(() => bytesResponse(200, new TextEncoder().encode('{"a":1}')));
    await expectRejected(createBankClient(BANK, f.fetch).fiFetch({ txnid: 't', sessionId: 's' }), {
      code: 'upstream_unavailable',
      stage: 'bank',
      status: 502,
    });
  });
});

const bankFiRequest = (f: ReturnType<typeof fakeFetch>) =>
  createBankClient(BANK, f.fetch).fiRequest(new Uint8Array([123, 125]), 'h..sig');

describe('bank client: errors', () => {
  const call = bankFiRequest;

  it.each([
    [400, 'SignatureDoesNotMatch'],
    [400, 'InvalidConsentId'],
    [401, 'Unauthorized'],
    [410, 'DataGone'],
  ])('maps ReBIT %i %s to the same code, stage bank, same status', async (status, code) => {
    const f = fakeFetch(() => jsonResponse(status, rebitError(code)));
    await expectRejected(call(f), { code, stage: 'bank', status });
  });

  it.each([
    [500, 'InternalError'],
    [503, 'ServiceUnavailable'],
  ])('keeps the code of a ReBIT %i and answers 502', async (status, code) => {
    const f = fakeFetch(() => jsonResponse(status, rebitError(code)));
    await expectRejected(call(f), { code, stage: 'bank', status: 502 });
  });

  it('turns a network error into upstream_unavailable 502 from the bank', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expectRejected(call(f), { code: 'upstream_unavailable', stage: 'bank', status: 502 });
  });

  it('turns a non-JSON success reply into upstream_unavailable 502 from the bank', async () => {
    const f = fakeFetch(() => new Response('nope', { status: 200 }));
    await expectRejected(call(f), { code: 'upstream_unavailable', stage: 'bank', status: 502 });
  });

  it('turns a reply of the wrong shape into upstream_unavailable 502 from the bank', async () => {
    const f = fakeFetch(() => jsonResponse(200, { unexpected: true }));
    await expectRejected(call(f), { code: 'upstream_unavailable', stage: 'bank', status: 502 });
  });

  it('does not carry the upstream errorMsg in the error', async () => {
    const f = fakeFetch(() => jsonResponse(400, rebitError('SignatureDoesNotMatch')));
    const e = await expectRejected(call(f), { code: 'SignatureDoesNotMatch', stage: 'bank' });
    expect(e.message).not.toContain('upstream text that must never be shown');
  });
});
