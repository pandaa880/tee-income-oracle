/**
 * The live bank through its HTTP surface (`app.request`, no port): fake attester registry,
 * injected clock and randomness, the committed test keys standing in for the demo AA/FIP
 * keys. The happy path plays the enclave and runs the result through `vectors/check-case.ts`
 * (the TS mirror of `tio_core::evaluate`).
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { sessionKeyPairFromScalar, type KeyMode } from '../crypto/ecdh.ts';
import { b64Encode, derToSingleLinePem, toHex, utf8 } from '../crypto/encoding.ts';
import { encodeDetached, signDetached, verifyCompact, verifyDetached } from '../crypto/jws.ts';
import type { RsaKey } from '../crypto/jws.ts';
import { buildFiRequest } from '../rebit/fi-request.ts';
import { buildKeyMaterial, isoUtc, type KeyMaterial } from '../rebit/key-material.ts';
import { reduceFi } from '../scoring/reduce.ts';
import { score } from '../scoring/score.ts';
import {
  SECP256K1_N,
  attesterAddress,
  bindingSignatureHex,
  counterRandom,
  fakeRegistry,
  publicJwk,
  testKeys,
  type FakeRegistry,
} from '../testing/fixtures.ts';
import { type CaseFiles } from '../vectors/cases.ts';
import { checkCase } from '../vectors/check-case.ts';
import { pinned } from '../vectors/keys.ts';
import { DEFAULT_POLICY } from '../vectors/policy.ts';
import { NOW_UNIX, type PersonaId } from '../vectors/personas.ts';
import { createApp } from './app.ts';

const keys = testKeys();
const DAY = 86_400;
const NOW0 = NOW_UNIX; // 2026-09-26T10:00:00Z
const TODAY0 = NOW0 - (NOW0 % DAY);
const FIU_JWK = publicJwk(keys.fiu);
const ATTESTER = attesterAddress(keys.enclaveSecp256k1);
const EXPECTED_TIER: Record<PersonaId, string> = {
  salaried_steady: 'A',
  trader_lumpy: 'B',
  declining: 'C',
  stressed: 'REJECT',
};
const PERSONAS = Object.keys(EXPECTED_TIER) as PersonaId[];
const ENCLAVE_NONCE = new Uint8Array(32).fill(0x5a);

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly registry: FakeRegistry;
  readonly clock: { t: number };
}

function setup(): Harness {
  const registry = fakeRegistry();
  registry.active.add(toHex(ATTESTER));
  const clock = { t: NOW0 };
  const app = createApp({
    aa: keys.aa,
    fip: keys.fip,
    registry,
    now: () => clock.t,
    random: counterRandom(),
  });
  return { app, registry, clock };
}

type Body = string | Uint8Array | Record<string, unknown> | unknown[];

function bodyBytes(body: Body): Uint8Array {
  if (body instanceof Uint8Array) return body;
  return utf8(typeof body === 'string' ? body : JSON.stringify(body));
}

async function post(
  h: Harness,
  path: string,
  body: Body,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await h.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: bodyBytes(body),
  });
}

interface Reply {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly json: Record<string, unknown>;
  readonly signature: string | null;
}

async function read(res: Response): Promise<Reply> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  return {
    status: res.status,
    bytes,
    json: parsed as Record<string, unknown>,
    signature: res.headers.get('x-jws-signature'),
  };
}

function expectSignedByAa(reply: Reply): void {
  expect(reply.signature).not.toBeNull();
  expect(verifyDetached(reply.signature ?? '', reply.bytes, [pinned(keys.aa)])).toEqual({
    ok: true,
    value: null,
  });
}

function expectError(reply: Reply, status: number, code: string): void {
  expect(reply.status).toBe(status);
  expect(reply.json['errorCode']).toBe(code);
  expect(reply.json['ver']).toBe('1.1.3');
  expect(typeof reply.json['errorMsg']).toBe('string');
  expect(typeof reply.json['timestamp']).toBe('string');
  expect(typeof reply.json['txnid']).toBe('string');
}

// ---- Flow helpers -------------------------------------------------------------------------

function registerBody(sigHex?: string): Record<string, unknown> {
  return {
    fiu_public_jwk: FIU_JWK,
    fiu_key_signature_hex: sigHex ?? bindingSignatureHex(FIU_JWK, keys.enclaveSecp256k1),
  };
}

async function register(h: Harness): Promise<Reply> {
  return await read(await post(h, '/fiu-keys', registerBody()));
}

async function newConsent(h: Harness, persona: PersonaId): Promise<Reply> {
  return await read(await post(h, '/Consent', { persona_id: persona }));
}

interface Enclave {
  readonly mode: KeyMode;
  readonly keyMaterial: KeyMaterial;
}

function enclaveFor(mode: KeyMode): Enclave {
  const pair = sessionKeyPairFromScalar(mode, keys.enclaveScalar);
  return { mode, keyMaterial: buildKeyMaterial(pair.publicSpki, ENCLAVE_NONCE, NOW0 + DAY) };
}

interface RequestOptions {
  readonly consent: Reply;
  readonly txnid?: string;
  readonly from?: string;
  readonly to?: string;
  readonly keyMaterial?: KeyMaterial;
  readonly signature?: string;
}

const DEFAULT_FROM = isoUtc(TODAY0 - 365 * DAY);
const DEFAULT_TO = isoUtc(TODAY0);

function fiRequestJson(o: RequestOptions, mode: KeyMode = 'x25519'): Record<string, unknown> {
  const signedConsent = String(o.consent.json['signedConsent']);
  return buildFiRequest({
    txnid: o.txnid ?? '11111111-2222-4333-8444-555555555555',
    timestamp: isoUtc(NOW0),
    consentId: String(o.consent.json['consentId']),
    consentSignature: o.signature ?? signedConsent.split('.')[2] ?? '',
    from: o.from ?? DEFAULT_FROM,
    to: o.to ?? DEFAULT_TO,
    keyMaterial: o.keyMaterial ?? enclaveFor(mode).keyMaterial,
  }) as Record<string, unknown>;
}

async function sendFiRequest(
  h: Harness,
  body: Uint8Array,
  signWith: RsaKey | null = keys.fiu,
): Promise<Reply> {
  const headers = signWith === null ? {} : { 'x-jws-signature': signDetached(body, signWith) };
  return await read(await post(h, '/FI/request', body, headers));
}

async function request(h: Harness, o: RequestOptions, mode: KeyMode = 'x25519'): Promise<Reply> {
  return await sendFiRequest(h, bodyBytes(fiRequestJson(o, mode)));
}

/** Registered key, one fresh consent, ready to send a request. */
async function ready(persona: PersonaId = 'salaried_steady') {
  const h = setup();
  expect((await register(h)).status).toBe(200);
  const consent = await newConsent(h, persona);
  expect(consent.status).toBe(200);
  return { h, consent };
}

async function fetchSession(h: Harness, txnid: string, sessionId: string): Promise<Reply> {
  const body = { ver: '1.1.3', timestamp: isoUtc(h.clock.t), txnid, sessionId };
  return await read(await post(h, '/FI/fetch', body));
}

// ---- Tests ----------------------------------------------------------------------------------

describe('GET /health', () => {
  it('is 200 {status: "ok"}', async () => {
    const res = await setup().app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('POST /fiu-keys', () => {
  it('registers the key of an active attester and returns kid and attester address', async () => {
    const reply = await register(setup());
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ kid: keys.fiu.kid, attester: `0x${toHex(ATTESTER)}` });
  });

  it('signs the response with the AA key', async () => {
    const reply = await register(setup());
    expect(reply.status).toBe(200);
    expectSignedByAa(reply);
  });

  it('is idempotent for the same kid and key', async () => {
    const h = setup();
    await register(h);
    expect((await register(h)).status).toBe(200);
  });

  it('refuses a key whose attester is not in the registry (401 Unauthorized)', async () => {
    const h = setup();
    h.registry.active.clear();
    expectError(await register(h), 401, 'Unauthorized');
  });

  it('refuses a binding signed by another secp256k1 key (401 Unauthorized)', async () => {
    const h = setup();
    const other = new Uint8Array(32).fill(0x33);
    const sig = bindingSignatureHex(FIU_JWK, other);
    expectError(await read(await post(h, '/fiu-keys', registerBody(sig))), 401, 'Unauthorized');
  });

  it('refuses a binding that was made for a different JWK (401 Unauthorized)', async () => {
    const h = setup();
    const sigForRogue = bindingSignatureHex(publicJwk(keys.rogue), keys.enclaveSecp256k1);
    expectError(
      await read(await post(h, '/fiu-keys', registerBody(sigForRogue))),
      401,
      'Unauthorized',
    );
  });

  it('answers 503 ServiceUnavailable, never "allow", when the registry is unreachable', async () => {
    const h = setup();
    h.registry.down = true;
    expectError(await register(h), 503, 'ServiceUnavailable');
  });

  it('does not register the key when refused: a later request with it fails on the kid', async () => {
    const h = setup();
    h.registry.active.clear();
    await register(h);
    h.registry.active.add(toHex(ATTESTER));
    const consent = await newConsent(h, 'salaried_steady');
    expectError(await request(h, { consent }), 400, 'SignatureDoesNotMatch');
  });

  const goodSig = bindingSignatureHex(FIU_JWK, keys.enclaveSecp256k1);
  const sigBytes = Buffer.from(goodSig, 'hex');

  function withByte(index: number, value: number): string {
    const copy = Buffer.from(sigBytes);
    copy[index] = value;
    return copy.toString('hex');
  }

  function highS(): string {
    const s = BigInt(`0x${goodSig.slice(64, 128)}`);
    const flipped = (SECP256K1_N - s).toString(16).padStart(64, '0');
    const v = Number(sigBytes[64]) ^ 1;
    return goodSig.slice(0, 64) + flipped + v.toString(16).padStart(2, '0');
  }

  it.each([
    ['too short (64 bytes)', goodSig.slice(0, 128)],
    ['too long (66 bytes)', `${goodSig}00`],
    ['not hex', 'zz'.repeat(65)],
    ['v = 27', withByte(64, 27)],
    ['v = 2', withByte(64, 2)],
    ['high-s', highS()],
    ['0x-prefixed', `0x${goodSig}`],
  ])('InvalidKey for a binding signature that is %s', async (_name, sig) => {
    const reply = await read(await post(setup(), '/fiu-keys', registerBody(sig)));
    expectError(reply, 400, 'InvalidKey');
  });

  it('InvalidKey for a JWK with an extra member', async () => {
    const jwk = { ...FIU_JWK, use: 'sig' };
    const body = { fiu_public_jwk: jwk, fiu_key_signature_hex: goodSig };
    expectError(await read(await post(setup(), '/fiu-keys', body)), 400, 'InvalidKey');
  });

  it('InvalidKey for a JWK that is not RSA', async () => {
    const jwk = { ...FIU_JWK, kty: 'EC' };
    const body = { fiu_public_jwk: jwk, fiu_key_signature_hex: goodSig };
    expectError(await read(await post(setup(), '/fiu-keys', body)), 400, 'InvalidKey');
  });

  it('InvalidKey for an RSA key under 2048 bits', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const exported = publicKey.export({ format: 'jwk' });
    const jwk = { kty: 'RSA', n: exported.n, e: exported.e, kid: randomUUID() };
    const sig = bindingSignatureHex(jwk as typeof FIU_JWK, keys.enclaveSecp256k1);
    const body = { fiu_public_jwk: jwk, fiu_key_signature_hex: sig };
    expectError(await read(await post(setup(), '/fiu-keys', body)), 400, 'InvalidKey');
  });

  it.each([
    ['a missing signature', { fiu_public_jwk: FIU_JWK }],
    ['a missing jwk', { fiu_key_signature_hex: goodSig }],
    ['an extra member', { ...registerBody(), extra: 1 }],
    ['a JSON array', []],
    ['a JSON string', '"text"'],
    ['text that is not JSON', 'not json'],
  ])('InvalidRequest for %s', async (_name, body) => {
    expectError(await read(await post(setup(), '/fiu-keys', body)), 400, 'InvalidRequest');
  });
});

describe('POST /Consent', () => {
  it('returns ver, timestamp, consentId and an AA-signed compact consent', async () => {
    const { consent } = await ready();
    expect(consent.status).toBe(200);
    expect(consent.json['ver']).toBe('1.1.3');
    expect(consent.json['timestamp']).toBe(isoUtc(NOW0));
    expect(typeof consent.json['consentId']).toBe('string');
    expect(typeof consent.json['signedConsent']).toBe('string');
    expectSignedByAa(consent);
  });

  it('the signedConsent verifies with the AA key and carries the FORMATS §5.3 terms', async () => {
    const { consent } = await ready();
    const verified = verifyCompact(String(consent.json['signedConsent']), [pinned(keys.aa)]);
    expect(verified.ok).toBe(true);
    const payload = JSON.parse(
      Buffer.from(verified.ok ? verified.value : new Uint8Array()).toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload['consentId']).toBe(consent.json['consentId']);
    expect(payload['status']).toBe('ACTIVE');
    expect(payload['fetchType']).toBe('ONETIME');
    expect(payload['fiTypes']).toEqual(['DEPOSIT']);
    expect(payload['consentStart']).toBe(isoUtc(NOW0 - 60));
    expect(payload['consentExpiry']).toBe(isoUtc(NOW0 + DAY));
    expect(payload['FIDataRange']).toEqual({
      from: isoUtc(TODAY0 - 366 * DAY),
      to: isoUtc(TODAY0 + DAY),
    });
  });

  it('gives each consent a fresh id', async () => {
    const h = setup();
    const a = await newConsent(h, 'salaried_steady');
    const b = await newConsent(h, 'salaried_steady');
    expect(a.json['consentId']).not.toBe(b.json['consentId']);
  });

  it.each([
    ['an unknown persona', { persona_id: 'whale' }],
    ['no persona', {}],
    ['an extra member', { persona_id: 'stressed', extra: true }],
    ['a JSON array', []],
    ['text that is not JSON', 'oops'],
  ])('InvalidRequest for %s', async (_name, body) => {
    expectError(await read(await post(setup(), '/Consent', body)), 400, 'InvalidRequest');
  });

  it('413 InvalidRequest for a body over 64 KiB', async () => {
    const reply = await read(await post(setup(), '/Consent', 'a'.repeat(64 * 1024 + 1)));
    expectError(reply, 413, 'InvalidRequest');
  });

  it('a body of exactly 64 KiB is not refused for its size', async () => {
    const [head, tail] = ['{"persona_id":"stressed","pad":"', '"}'] as const;
    const padded = head + 'a'.repeat(64 * 1024 - head.length - tail.length) + tail;
    const reply = await read(await post(setup(), '/Consent', padded));
    expect(reply.status).toBe(400); // too big for the schema, not for the limit
    expectError(reply, 400, 'InvalidRequest');
  });

  it('413 also for a body with no Content-Length (streamed)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40 * 1024).fill(0x61));
        controller.enqueue(new Uint8Array(40 * 1024).fill(0x61));
        controller.close();
      },
    });
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit;
    const res = await setup().app.request('/Consent', init);
    expectError(await read(res), 413, 'InvalidRequest');
  });
});

describe('POST /FI/request: acceptance', () => {
  it('acks with ver, timestamp, the request txnid, the consentId and a sessionId', async () => {
    const { h, consent } = await ready();
    const txnid = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    const ack = await request(h, { consent, txnid });
    expect(ack.status).toBe(200);
    expect(ack.json['ver']).toBe('1.1.3');
    expect(typeof ack.json['timestamp']).toBe('string');
    expect(ack.json['txnid']).toBe(txnid);
    expect(ack.json['consentId']).toBe(consent.json['consentId']);
    expect(typeof ack.json['sessionId']).toBe('string');
    expectSignedByAa(ack);
  });

  it('accepts a request range equal to the consent range', async () => {
    const { h, consent } = await ready();
    const ack = await request(h, {
      consent,
      from: isoUtc(TODAY0 - 366 * DAY),
      to: isoUtc(TODAY0 + DAY),
    });
    expect(ack.status).toBe(200);
  });

  it('accepts a request after the UTC midnight that follows the consent (±1 day range)', async () => {
    const { h, consent } = await ready();
    h.clock.t = TODAY0 + DAY + 600;
    const ack = await request(h, {
      consent,
      from: isoUtc(TODAY0 - 364 * DAY),
      to: isoUtc(TODAY0 + DAY),
    });
    expect(ack.status).toBe(200);
  });
});

describe('POST /FI/request: signature and registry', () => {
  it('SignatureDoesNotMatch (400) without x-jws-signature', async () => {
    const { h, consent } = await ready();
    const body = bodyBytes(fiRequestJson({ consent }));
    expectError(await sendFiRequest(h, body, null), 400, 'SignatureDoesNotMatch');
  });

  it('SignatureDoesNotMatch (400) when the JWS names a kid that was never registered', async () => {
    const { h, consent } = await ready();
    const body = bodyBytes(fiRequestJson({ consent }));
    expectError(await sendFiRequest(h, body, keys.rogue), 400, 'SignatureDoesNotMatch');
  });

  it('SignatureDoesNotMatch (400) from an FIU that never registered', async () => {
    const h = setup();
    const consent = await newConsent(h, 'salaried_steady');
    expectError(await request(h, { consent }), 400, 'SignatureDoesNotMatch');
  });

  it('SignatureDoesNotMatch (400) when the body was changed after signing', async () => {
    const { h, consent } = await ready();
    const signed = bodyBytes(fiRequestJson({ consent }));
    const other = bodyBytes(fiRequestJson({ consent, txnid: 'changed-after-signing' }));
    const reply = await read(
      await post(h, '/FI/request', other, { 'x-jws-signature': signDetached(signed, keys.fiu) }),
    );
    expectError(reply, 400, 'SignatureDoesNotMatch');
  });

  it.each([
    ['alg none', { alg: 'none', kid: keys.fiu.kid, b64: false, crit: ['b64'] }],
    ['alg HS256', { alg: 'HS256', kid: keys.fiu.kid, b64: false, crit: ['b64'] }],
    ['an embedded jwk', { alg: 'RS256', kid: keys.fiu.kid, b64: false, crit: ['b64'], jwk: {} }],
  ])('SignatureDoesNotMatch (400) for a JWS header with %s', async (_name, header) => {
    const { h, consent } = await ready();
    const body = bodyBytes(fiRequestJson({ consent }));
    const jws = encodeDetached(header, body, () => new Uint8Array(32));
    const reply = await read(await post(h, '/FI/request', body, { 'x-jws-signature': jws }));
    expectError(reply, 400, 'SignatureDoesNotMatch');
  });

  it('Unauthorized (401) once the attester of a registered key is revoked', async () => {
    const { h, consent } = await ready();
    h.registry.active.clear();
    expectError(await request(h, { consent }), 401, 'Unauthorized');
  });

  it('ServiceUnavailable (503), never "allow", when the registry is down at request time', async () => {
    const { h, consent } = await ready();
    h.registry.down = true;
    expectError(await request(h, { consent }), 503, 'ServiceUnavailable');
  });

  it('InternalError (500) with a generic message if the registry throws', async () => {
    const { h, consent } = await ready();
    h.registry.isActive = () => Promise.reject(new Error('secret-detail-from-the-registry'));
    const reply = await request(h, { consent });
    expectError(reply, 500, 'InternalError');
    expect(String(reply.json['errorMsg'])).not.toContain('secret-detail');
  });

  it('does not use up the consent when the request is refused', async () => {
    const { h, consent } = await ready();
    h.registry.down = true;
    await request(h, { consent });
    h.registry.down = false;
    expect((await request(h, { consent })).status).toBe(200);
  });
});

async function signedRaw(body: Body): Promise<Reply> {
  const { h } = await ready();
  return await sendFiRequest(h, bodyBytes(body));
}

describe('POST /FI/request: body shape (InvalidRequest)', () => {
  it('a signed body that is not JSON', async () => {
    expectError(await signedRaw('not json at all'), 400, 'InvalidRequest');
  });

  it('a signed JSON array', async () => {
    expectError(await signedRaw([]), 400, 'InvalidRequest');
  });

  it('a signed body without KeyMaterial', async () => {
    const { h, consent } = await ready();
    const { KeyMaterial: _omitted, ...rest } = fiRequestJson({ consent });
    expectError(await sendFiRequest(h, bodyBytes(rest)), 400, 'InvalidRequest');
  });

  it('a signed body with an extra member', async () => {
    const { h, consent } = await ready();
    const body = { ...fiRequestJson({ consent }), extra: 'member' };
    expectError(await sendFiRequest(h, bodyBytes(body)), 400, 'InvalidRequest');
  });

  it('a signed body without a txnid', async () => {
    const { h, consent } = await ready();
    const { txnid: _omitted, ...rest } = fiRequestJson({ consent });
    expectError(await sendFiRequest(h, bodyBytes(rest)), 400, 'InvalidRequest');
  });

  it('413 for a body over 64 KiB, before any signature work', async () => {
    const { h } = await ready();
    const reply = await read(await post(h, '/FI/request', 'a'.repeat(64 * 1024 + 1)));
    expectError(reply, 413, 'InvalidRequest');
  });
});

describe('POST /FI/request: consent rules', () => {
  it('InvalidConsentId (400) for a consent the AA never issued', async () => {
    const { h, consent } = await ready();
    const stranger = {
      ...consent,
      json: { ...consent.json, consentId: 'ffffffff-0000-4000-8000-000000000000' },
    };
    expectError(await request(h, { consent: stranger }), 400, 'InvalidConsentId');
  });

  it('InvalidConsentStatus (400) for an expired consent', async () => {
    const { h, consent } = await ready();
    h.clock.t = NOW0 + DAY + 1;
    expectError(await request(h, { consent }), 400, 'InvalidConsentStatus');
  });

  it('InvalidConsentUse (400) when the consent was already used (ONETIME)', async () => {
    const { h, consent } = await ready();
    expect((await request(h, { consent })).status).toBe(200);
    const second = await request(h, { consent, txnid: '22222222-3333-4444-8555-666666666666' });
    expectError(second, 400, 'InvalidConsentUse');
  });

  it('InvalidConsentUse (400) when the identical signed request is replayed', async () => {
    const { h, consent } = await ready();
    const body = bodyBytes(fiRequestJson({ consent }));
    expect((await sendFiRequest(h, body)).status).toBe(200);
    expectError(await sendFiRequest(h, body), 400, 'InvalidConsentUse');
  });

  it('InvalidConsentDetail (400) when Consent.digitalSignature is not the issued one', async () => {
    const { h, consent } = await ready();
    const wrong = await newConsent(h, 'salaried_steady');
    const otherSignature = String(wrong.json['signedConsent']).split('.')[2] ?? '';
    expectError(
      await request(h, { consent, signature: otherSignature }),
      400,
      'InvalidConsentDetail',
    );
  });

  it('InvalidConsentDetail (400) for an empty digitalSignature', async () => {
    const { h, consent } = await ready();
    expectError(await request(h, { consent, signature: '' }), 400, 'InvalidConsentDetail');
  });
});

describe('POST /FI/request: date range (InvalidDateRange)', () => {
  it.each([
    ['from equals to', { from: DEFAULT_TO, to: DEFAULT_TO }],
    ['from after to', { from: DEFAULT_TO, to: DEFAULT_FROM }],
    ['to after the consent range', { to: isoUtc(TODAY0 + 2 * DAY) }],
    ['from before the consent range', { from: isoUtc(TODAY0 - 367 * DAY) }],
    ['a timestamp that is not an ISO date-time', { from: 'yesterday' }],
    ['a date without a time', { to: '2026-09-26' }],
  ])('400 when %s', async (_name, range) => {
    const { h, consent } = await ready();
    expectError(await request(h, { consent, ...range }), 400, 'InvalidDateRange');
  });

  it('does not use up the consent when the range is refused', async () => {
    const { h, consent } = await ready();
    await request(h, { consent, from: DEFAULT_TO, to: DEFAULT_FROM });
    expect((await request(h, { consent })).status).toBe(200);
  });
});

function withKeyValue(valueB64: string): KeyMaterial {
  const km = enclaveFor('x25519').keyMaterial;
  return { ...km, DHPublicKey: { ...km.DHPublicKey, KeyValue: valueB64 } };
}

describe('POST /FI/request: session key material (InvalidKey)', () => {
  it('400 for an SPKI that is neither wei25519 nor X25519', async () => {
    const { h, consent } = await ready();
    const keyMaterial = withKeyValue(derToSingleLinePem(new Uint8Array(40)));
    expectError(await request(h, { consent, keyMaterial }), 400, 'InvalidKey');
  });

  it('400 for a wei25519 key that is not on the curve', async () => {
    const { h, consent } = await ready();
    const km = enclaveFor('wei25519').keyMaterial;
    const spki = Buffer.from(
      km.DHPublicKey.KeyValue.replace('-----BEGIN PUBLIC KEY-----', '').replace(
        '-----END PUBLIC KEY-----',
        '',
      ),
      'base64',
    );
    spki[spki.length - 1] = (spki[spki.length - 1] ?? 0) ^ 0xff;
    const keyMaterial = withKeyValue(derToSingleLinePem(new Uint8Array(spki)));
    expectError(await request(h, { consent, keyMaterial }), 400, 'InvalidKey');
  });

  it('400 for a nonce that is not 32 bytes', async () => {
    const { h, consent } = await ready();
    const keyMaterial = {
      ...enclaveFor('x25519').keyMaterial,
      Nonce: b64Encode(new Uint8Array(16)),
    };
    expectError(await request(h, { consent, keyMaterial }), 400, 'InvalidKey');
  });

  it('400 for a small-order X25519 point (all-zero shared secret)', async () => {
    const { h, consent } = await ready();
    const prefix = Buffer.from('302a300506032b656e032100', 'hex');
    const zeroPoint = derToSingleLinePem(new Uint8Array(Buffer.concat([prefix, Buffer.alloc(32)])));
    expectError(
      await request(h, { consent, keyMaterial: withKeyValue(zeroPoint) }),
      400,
      'InvalidKey',
    );
  });

  it('does not use up the consent when the key material is refused', async () => {
    const { h, consent } = await ready();
    const keyMaterial = {
      ...enclaveFor('x25519').keyMaterial,
      Nonce: b64Encode(new Uint8Array(3)),
    };
    await request(h, { consent, keyMaterial });
    expect((await request(h, { consent })).status).toBe(200);
  });
});

describe('POST /FI/fetch', () => {
  const TXN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  async function acked() {
    const { h, consent } = await ready();
    const ack = await request(h, { consent, txnid: TXN });
    expect(ack.status).toBe(200);
    return { h, consent, sessionId: String(ack.json['sessionId']) };
  }

  it('returns 200 with an AA-signed fetch response for the same txnid', async () => {
    const { h, sessionId } = await acked();
    const reply = await fetchSession(h, TXN, sessionId);
    expect(reply.status).toBe(200);
    expect(reply.json['ver']).toBe('1.1.3');
    expect(reply.json['txnid']).toBe(TXN);
    expectSignedByAa(reply);
  });

  it('returns the §5.2 shape: one FI entry with one account, KeyMaterial on the entry', async () => {
    const { h, sessionId } = await acked();
    const reply = await fetchSession(h, TXN, sessionId);
    const fi = reply.json['FI'] as Record<string, unknown>[];
    expect(fi).toHaveLength(1);
    expect(fi[0]?.['fipID']).toBe('SANDBOX-FIP');
    expect(fi[0]?.['data']).toHaveLength(1);
    expect(fi[0]?.['KeyMaterial']).toBeDefined();
  });

  it('needs no FIU signature (the data is encrypted to the enclave)', async () => {
    const { h, sessionId } = await acked();
    const body = { ver: '1.1.3', timestamp: isoUtc(NOW0), txnid: TXN, sessionId };
    expect((await post(h, '/FI/fetch', body)).status).toBe(200);
  });

  it('InvalidSessionId (400) for an unknown session', async () => {
    const { h } = await acked();
    expectError(await fetchSession(h, TXN, 'no-such-session'), 400, 'InvalidSessionId');
  });

  it('InvalidSessionId (400) once the session has expired (600 s)', async () => {
    const { h, sessionId } = await acked();
    h.clock.t = NOW0 + 601;
    expectError(await fetchSession(h, TXN, sessionId), 400, 'InvalidSessionId');
  });

  it('still serves a session just inside its 600 s', async () => {
    const { h, sessionId } = await acked();
    h.clock.t = NOW0 + 590;
    expect((await fetchSession(h, TXN, sessionId)).status).toBe(200);
  });

  it("InvalidRequest (400) when the txnid is not the session's", async () => {
    const { h, sessionId } = await acked();
    expectError(await fetchSession(h, 'another-txnid', sessionId), 400, 'InvalidRequest');
  });

  it('DataGone (410) on the second fetch of the same session', async () => {
    const { h, sessionId } = await acked();
    expect((await fetchSession(h, TXN, sessionId)).status).toBe(200);
    expectError(await fetchSession(h, TXN, sessionId), 410, 'DataGone');
  });

  it('a wrong-txnid attempt does not use up the session', async () => {
    const { h, sessionId } = await acked();
    await fetchSession(h, 'another-txnid', sessionId);
    expect((await fetchSession(h, TXN, sessionId)).status).toBe(200);
  });

  it.each([
    ['no sessionId', { ver: '1.1.3', timestamp: 't', txnid: TXN }],
    ['no txnid', { ver: '1.1.3', timestamp: 't', sessionId: 's' }],
    ['an extra member', { ver: '1.1.3', timestamp: 't', txnid: TXN, sessionId: 's', x: 1 }],
    ['a JSON array', []],
    ['text that is not JSON', 'oops'],
  ])('InvalidRequest (400) for %s', async (_name, body) => {
    const { h } = await acked();
    expectError(await read(await post(h, '/FI/fetch', body)), 400, 'InvalidRequest');
  });
});

describe('error bodies', () => {
  it('echo the request txnid when the body parsed', async () => {
    const { h, consent } = await ready();
    const stranger = {
      ...consent,
      json: { ...consent.json, consentId: 'ffffffff-0000-4000-8000-000000000000' },
    };
    const txnid = 'abcdef12-0000-4000-8000-000000000042';
    const reply = await request(h, { consent: stranger, txnid });
    expect(reply.json['txnid']).toBe(txnid);
  });

  it('have an empty txnid when the body could not be parsed', async () => {
    const { h } = await ready();
    const reply = await sendFiRequest(h, utf8('not json'));
    expect(reply.json['txnid']).toBe('');
  });

  it('never repeat request data in errorMsg', async () => {
    const { h, consent } = await ready();
    const txnid = 'abcdef12-0000-4000-8000-000000000043';
    const strangerId = 'ffffffff-0000-4000-8000-0000000000aa';
    const stranger = { ...consent, json: { ...consent.json, consentId: strangerId } };
    const reply = await request(h, { consent: stranger, txnid });
    const msg = String(reply.json['errorMsg']);
    expect(msg).not.toContain(txnid);
    expect(msg).not.toContain(strangerId);
    expect(msg).not.toContain(keys.fiu.kid);
  });
});

describe('end to end: consent, register, request, fetch, then the enclave pipeline', () => {
  const MODES: readonly KeyMode[] = ['wei25519', 'x25519'];
  const cases = PERSONAS.flatMap((persona) => MODES.map((mode) => [persona, mode] as const));

  it.each(cases)('%s (%s) passes check-case and scores to its tier', async (persona, mode) => {
    const h = setup();
    expect((await register(h)).status).toBe(200);
    const consent = await newConsent(h, persona);
    const txnid = '01234567-89ab-4cde-8f01-23456789abcd';
    const ack = await request(h, { consent, txnid }, mode);
    expect(ack.status).toBe(200);
    const fetched = await fetchSession(h, txnid, String(ack.json['sessionId']));
    expect(fetched.status).toBe(200);
    expectSignedByAa(fetched);

    const session = {
      case_id: `live-${persona}-${mode}`,
      mode,
      enclave_nonce_b64: b64Encode(ENCLAVE_NONCE),
      txnid,
      consent_id: String(consent.json['consentId']),
      now_unix: h.clock.t,
      fi_data_range: { from: DEFAULT_FROM, to: DEFAULT_TO },
    };
    const files: CaseFiles = new Map([
      ['session.json', utf8(JSON.stringify(session))],
      ['fetch_response.body', fetched.bytes],
      ['fetch_response.jws', utf8(fetched.signature ?? '')],
      ['consent.jws', utf8(String(consent.json['signedConsent']))],
    ]);
    const checked = checkCase(files, keys);
    expect(checked).toMatchObject({ ok: true });
    if (!checked.ok) return;
    const tier = score(reduceFi(Buffer.from(checked.fi).toString('utf8')), DEFAULT_POLICY).outcome;
    expect(tier).toBe(EXPECTED_TIER[persona]);
  });

  it('the AA-signed consent is accepted by the pipeline only for its own session (txnid binds)', async () => {
    const { h, consent } = await ready();
    const txnid = '01234567-89ab-4cde-8f01-23456789abcd';
    const ack = await request(h, { consent, txnid });
    const fetched = await fetchSession(h, txnid, String(ack.json['sessionId']));
    const session = {
      mode: 'x25519',
      enclave_nonce_b64: b64Encode(ENCLAVE_NONCE),
      txnid: 'a-different-txnid',
      consent_id: String(consent.json['consentId']),
      now_unix: h.clock.t,
      fi_data_range: { from: DEFAULT_FROM, to: DEFAULT_TO },
    };
    const files: CaseFiles = new Map([
      ['session.json', utf8(JSON.stringify(session))],
      ['fetch_response.body', fetched.bytes],
      ['fetch_response.jws', utf8(fetched.signature ?? '')],
      ['consent.jws', utf8(String(consent.json['signedConsent']))],
    ]);
    expect(checkCase(files, keys)).toEqual({ ok: false, code: 'session_mismatch' });
  });
});

describe('review round 1 regressions', () => {
  it('a request made before UTC midnight and served after it still passes the pipeline', async () => {
    const { h, consent } = await ready('salaried_steady');
    // The enclave set `to` = TODAY0 by its clock; the bank sees the request after midnight.
    h.clock.t = TODAY0 + DAY + 60;
    const txnid = '0badcafe-0000-4000-8000-000000000001';
    const ack = await request(h, { consent, txnid });
    expect(ack.status).toBe(200);
    const fetched = await fetchSession(h, txnid, String(ack.json['sessionId']));
    expect(fetched.status).toBe(200);
    const session = {
      case_id: 'live-midnight',
      mode: 'x25519',
      enclave_nonce_b64: b64Encode(ENCLAVE_NONCE),
      txnid,
      consent_id: String(consent.json['consentId']),
      now_unix: h.clock.t,
      fi_data_range: { from: DEFAULT_FROM, to: DEFAULT_TO },
    };
    const files: CaseFiles = new Map([
      ['session.json', utf8(JSON.stringify(session))],
      ['fetch_response.body', fetched.bytes],
      ['fetch_response.jws', utf8(fetched.signature ?? '')],
      ['consent.jws', utf8(String(consent.json['signedConsent']))],
    ]);
    expect(checkCase(files, keys)).toMatchObject({ ok: true });
  });

  it('an unknown route gets a ReBIT error body with 404', async () => {
    const reply = await read(await post(setup(), '/no/such/route', {}));
    expectError(reply, 404, 'InvalidRequest');
  });

  it('a flood of unused consents cannot lock out a new borrower', async () => {
    const { h, consent } = await ready('salaried_steady');
    for (let i = 0; i < 1030; i += 1) {
      expect((await newConsent(h, 'stressed')).status).toBe(200);
    }
    // The flood evicted the oldest unused consent, but a fresh one still works end to end.
    const fresh = await newConsent(h, 'salaried_steady');
    expect(fresh.status).toBe(200);
    expect((await request(h, { consent: fresh })).status).toBe(200);
    expectError(await request(h, { consent }), 400, 'InvalidConsentId');
  }, 60_000);
});
