/**
 * The live sandbox bank (mock FIP + AA) without HTTP: each operation takes
 * the raw request and returns a JSON reply or a ReBIT error code. The bank
 * encrypts a statement only to a session key carried in an FI request that
 * is signed by an FIU key whose FORMATS §8.1 binding recovers to the
 * attester of an active oracle registry entry (§13).
 *
 * Expected refusals are thrown as `Refusal` inside an operation and turned
 * into a `BankReply` at its edge (`asReply`), so the public `Bank` API is a
 * Result; anything else that throws is a bug and reaches the app's 500.
 */

import { createPublicKey } from 'node:crypto';

import { z } from 'zod';

import { recoverAttester } from '../chain/fiu-binding.ts';
import type { AttesterRegistry } from '../chain/registry.ts';
import { DecryptError } from '../crypto/cipher.ts';
import { KeyError } from '../crypto/ecdh.ts';
import { b64urlDecode, fromHex, jsonBytes, toHex, utf8 } from '../crypto/encoding.ts';
import type { JsonValue } from '../crypto/jcs.ts';
import { signCompact, signDetached, verifyDetached, type RsaKey } from '../crypto/jws.ts';
import type { RsaPublicJwk } from '../crypto/rsa-jwk.ts';
import { buildConsent } from '../rebit/consent.ts';
import { buildFetchResponse } from '../rebit/fetch-response.ts';
import { REBIT_VERSION } from '../rebit/fi-request.ts';
import { isoUtc, parseKeyMaterial } from '../rebit/key-material.ts';
import { seal, type Sealed } from '../rebit/seal.ts';
import { parseRebitTimestamp } from '../rebit/timestamp.ts';
import type { PersonaId } from '../vectors/personas.ts';
import { uuidFromSeed } from '../vectors/prng.ts';
import { personaFi } from './live-personas.ts';
import type { RebitCode } from './rebit-error.ts';
import {
  createConsentStore,
  createFiuKeyStore,
  createSessionStore,
  type ConsentRecord,
} from './stores.ts';

export interface BankDeps {
  readonly aa: RsaKey;
  readonly fip: RsaKey;
  readonly registry: AttesterRegistry;
  /** Unix seconds. */
  readonly now: () => number;
  /** Cryptographic randomness: ids, the FIP's one-time key and nonce. */
  readonly random: (n: number) => Uint8Array;
}

/** `txnid` is the request's when it was read, for the error body. */
export type BankReply =
  /** `jws`: the AA signature over `body`, when the bank already made it. */
  | { readonly ok: true; readonly body: Uint8Array; readonly jws?: string }
  | { readonly ok: false; readonly code: RebitCode; readonly txnid: string };

export interface Bank {
  registerFiuKey(body: Uint8Array): Promise<BankReply>;
  issueConsent(body: Uint8Array): BankReply;
  fiRequest(body: Uint8Array, jws: string | undefined): Promise<BankReply>;
  fetch(body: Uint8Array): BankReply;
}

const DAY = 86_400;
const CONSENT_LIFETIME = DAY;
const CONSENT_START_SKEW = 60;
/** The enclave requests `[today − 365 d, today]`; one spare day each side covers UTC midnight. */
const CONSENT_FROM_DAYS = 366;
const CONSENT_TO_DAYS = 1;
/** Same as the enclave's session TTL (FORMATS §10). */
const SESSION_TTL = 600;
const KEY_MATERIAL_TTL = DAY;
const MIN_RSA_BITS = 2048;
const MASKED_ACCOUNT = 'XXXXXXXX1234';

const PERSONA_IDS = ['salaried_steady', 'trader_lumpy', 'declining', 'stressed'] as const;

const RegisterSchema = z.strictObject({
  fiu_public_jwk: z.record(z.string(), z.unknown()),
  fiu_key_signature_hex: z.string(),
});
const FiuJwkSchema = z.strictObject({
  e: z.string().min(1),
  kid: z.string().min(1),
  kty: z.literal('RSA'),
  n: z.string().min(1),
});
const ConsentRequestSchema = z.strictObject({ persona_id: z.enum(PERSONA_IDS) });
/** FORMATS §5.1. `KeyMaterial` members are checked by `parseKeyMaterial`. */
const FiRequestSchema = z.strictObject({
  ver: z.string(),
  timestamp: z.string(),
  txnid: z.string().min(1),
  Consent: z.strictObject({ id: z.string(), digitalSignature: z.string() }),
  FIDataRange: z.strictObject({ from: z.string(), to: z.string() }),
  KeyMaterial: z.record(z.string(), z.unknown()),
});
const FetchRequestSchema = z.strictObject({
  ver: z.string(),
  timestamp: z.string(),
  txnid: z.string(),
  sessionId: z.string(),
});

/** A refusal raised inside one operation and turned into its `BankReply`. */
class Refusal extends Error {
  override readonly name = 'Refusal';
  readonly code: RebitCode;
  readonly txnid: string;

  constructor(code: RebitCode, txnid = '', options?: ErrorOptions) {
    super(code, options);
    this.code = code;
    this.txnid = txnid;
  }
}

function reply(value: JsonValue): BankReply {
  return { ok: true, body: jsonBytes(value, 0) };
}

export function createBank(deps: BankDeps): Bank {
  const consents = createConsentStore({ now: deps.now });
  const sessions = createSessionStore({ now: deps.now });
  const fiuKeys = createFiuKeyStore({});
  const newId = (): string => uuidFromSeed(deps.random(16));

  async function registerFiuKey(body: Uint8Array): Promise<BankReply> {
    const req = parse(RegisterSchema, body);
    const jwk = rsaPublicJwk(req.fiu_public_jwk);
    const attester = bindingAttester(req.fiu_key_signature_hex, jwk);
    await requireActive(deps.registry, attester, '');
    const publicKey = createPublicKey({ key: { ...jwk }, format: 'jwk' });
    fiuKeys.put({ kid: jwk.kid, key: { kid: jwk.kid, publicKey }, attester });
    return reply({ kid: jwk.kid, attester: `0x${toHex(attester)}` });
  }

  function issueConsent(body: Uint8Array): BankReply {
    const { persona_id: personaId } = parse(ConsentRequestSchema, body);
    const now = deps.now();
    const today = now - (now % DAY);
    const record = consentRecord(personaId, newId(), now, today, deps.aa);
    if (!consents.add(record)) {
      throw new Refusal('ServiceUnavailable');
    }
    return reply({
      ver: REBIT_VERSION,
      timestamp: isoUtc(now),
      consentId: record.consentId,
      signedConsent: record.jws,
    });
  }

  async function fiRequest(body: Uint8Array, jws: string | undefined): Promise<BankReply> {
    const fiu = fiuKeys.get(jwsKid(jws) ?? '');
    if (jws === undefined || fiu === undefined || !verifyDetached(jws, body, [fiu.key]).ok) {
      throw new Refusal('SignatureDoesNotMatch');
    }
    await requireActive(deps.registry, fiu.attester, '');
    const req = parse(FiRequestSchema, body);
    const now = deps.now();
    const consent = usableConsent(consents.get(req.Consent.id), req, now);
    const range = requireRangeInside(req, consent);
    // A `to` after now only comes from a misbehaving enclave: never date data in the future.
    const anchor = Math.min(range.to, now);
    const sealed = sealFor(consent.personaId, req.KeyMaterial, anchor, now, deps, req.txnid);
    const sessionId = newId();
    const fetchBody = jsonBytes(fetchResponse(req.txnid, now, sealed, newId()), 0);
    const session = {
      sessionId,
      txnid: req.txnid,
      consentId: consent.consentId,
      fetchBody,
      fetchJws: signDetached(fetchBody, deps.aa),
      expiresAt: now + SESSION_TTL,
      fetched: false,
    };
    if (!sessions.add(session)) {
      throw new Refusal('ServiceUnavailable', req.txnid);
    }
    consents.markUsed(consent.consentId);
    return reply({
      ver: REBIT_VERSION,
      timestamp: isoUtc(now),
      txnid: req.txnid,
      consentId: consent.consentId,
      sessionId,
    });
  }

  function fetchFi(body: Uint8Array): BankReply {
    const req = parse(FetchRequestSchema, body);
    const session = sessions.get(req.sessionId);
    if (session === undefined) {
      throw new Refusal('InvalidSessionId', req.txnid);
    }
    if (session.txnid !== req.txnid) {
      throw new Refusal('InvalidRequest', req.txnid);
    }
    if (session.fetched) {
      throw new Refusal('DataGone', req.txnid);
    }
    sessions.markFetched(session.sessionId);
    return { ok: true, body: session.fetchBody, jws: session.fetchJws };
  }

  return {
    registerFiuKey: (body) => refusalsAsReplies(() => registerFiuKey(body)),
    issueConsent: (body) => refusalAsReply(() => issueConsent(body)),
    fiRequest: (body, jws) => refusalsAsReplies(() => fiRequest(body, jws)),
    fetch: (body) => refusalAsReply(() => fetchFi(body)),
  };
}

function consentRecord(
  personaId: PersonaId,
  consentId: string,
  now: number,
  today: number,
  aa: RsaKey,
): ConsentRecord {
  const from = today - CONSENT_FROM_DAYS * DAY;
  const to = today + CONSENT_TO_DAYS * DAY;
  const expiresAt = now + CONSENT_LIFETIME;
  const consent = buildConsent({
    consentId,
    status: 'ACTIVE',
    start: isoUtc(now - CONSENT_START_SKEW),
    expiry: isoUtc(expiresAt),
    from: isoUtc(from),
    to: isoUtc(to),
  });
  const jws = signCompact(utf8(JSON.stringify(consent)), aa);
  const signature = jws.split('.')[2] ?? '';
  return { consentId, personaId, jws, signature, from, to, expiresAt, used: false };
}

/** Consent checks in ReBIT order: known, active, unused, same signature. */
function usableConsent(
  consent: ConsentRecord | undefined,
  req: z.infer<typeof FiRequestSchema>,
  now: number,
): ConsentRecord {
  if (consent === undefined) {
    throw new Refusal('InvalidConsentId', req.txnid);
  }
  if (now >= consent.expiresAt) {
    throw new Refusal('InvalidConsentStatus', req.txnid);
  }
  if (consent.used) {
    throw new Refusal('InvalidConsentUse', req.txnid);
  }
  if (req.Consent.digitalSignature !== consent.signature) {
    throw new Refusal('InvalidConsentDetail', req.txnid);
  }
  return consent;
}

/** The requested range (unix seconds) if well-formed and inside the consent's, else `InvalidDateRange`. */
function requireRangeInside(
  req: z.infer<typeof FiRequestSchema>,
  consent: ConsentRecord,
): { readonly from: number; readonly to: number } {
  const from = parseRebitTimestamp(req.FIDataRange.from);
  const to = parseRebitTimestamp(req.FIDataRange.to);
  if (from === undefined || to === undefined || from >= to) {
    throw new Refusal('InvalidDateRange', req.txnid);
  }
  if (from < consent.from || to > consent.to) {
    throw new Refusal('InvalidDateRange', req.txnid);
  }
  return { from, to };
}

/**
 * Encrypts the persona statement ending on the requested `to` day to the
 * enclave's key; a bad key is `InvalidKey`. Anchoring on `to`, not on the
 * bank's clock, keeps the statement inside the requested window when a
 * request made before UTC midnight arrives after it (enclave check 15).
 */
function sealFor(
  personaId: PersonaId,
  keyMaterial: unknown,
  anchor: number,
  now: number,
  deps: BankDeps,
  txnid: string,
): Sealed {
  try {
    const peer = parseKeyMaterial(keyMaterial);
    return seal({
      fi: jsonBytes(personaFi(personaId, anchor), 0),
      fipKey: deps.fip,
      peerSpki: peer.spki,
      peerNonce: peer.nonce,
      fipScalar: deps.random(32),
      fipNonce: deps.random(32),
      expiryUnix: now + KEY_MATERIAL_TTL,
    });
  } catch (e) {
    if (e instanceof KeyError || e instanceof DecryptError) {
      throw new Refusal('InvalidKey', txnid, { cause: e });
    }
    throw e;
  }
}

function fetchResponse(txnid: string, now: number, sealed: Sealed, linkRef: string): JsonValue {
  return buildFetchResponse({
    txnid,
    timestamp: isoUtc(now),
    linkRefNumber: linkRef,
    maskedAccNumber: MASKED_ACCOUNT,
    encryptedFi: sealed.encryptedFi,
    keyMaterial: sealed.keyMaterial,
  });
}

/** An FIU public JWK (exactly `e, kid, kty, n`, RSA ≥ 2048 bits), else `InvalidKey`. */
function rsaPublicJwk(value: Record<string, unknown>): RsaPublicJwk {
  const jwk = FiuJwkSchema.safeParse(value);
  if (!jwk.success) {
    throw new Refusal('InvalidKey');
  }
  let bits = 0;
  try {
    const key = createPublicKey({ key: { ...jwk.data }, format: 'jwk' });
    bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  } catch {
    throw new Refusal('InvalidKey');
  }
  if (bits < MIN_RSA_BITS) {
    throw new Refusal('InvalidKey');
  }
  return jwk.data;
}

/** The attester address of a §8.1 binding signature (130 hex chars, r ‖ s ‖ v). */
function bindingAttester(sigHex: string, jwk: RsaPublicJwk): Uint8Array {
  const attester = /^[0-9a-fA-F]{130}$/.test(sigHex)
    ? recoverAttester(fromHex(sigHex.toLowerCase()), jwk)
    : undefined;
  if (attester === undefined) {
    throw new Refusal('InvalidKey');
  }
  return attester;
}

async function requireActive(
  registry: AttesterRegistry,
  attester: Uint8Array,
  txnid: string,
): Promise<void> {
  const result = await registry.isActive(attester);
  if (!result.ok) {
    throw new Refusal('ServiceUnavailable', txnid);
  }
  if (!result.active) {
    throw new Refusal('Unauthorized', txnid);
  }
}

/** The `kid` of a detached JWS header, without verifying anything. */
function jwsKid(jws: string | undefined): string | undefined {
  const header = jws?.split('.')[0];
  if (header === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(b64urlDecode(header)).toString('utf8'));
    const kid = z.object({ kid: z.string() }).safeParse(value);
    return kid.success ? kid.data.kid : undefined;
  } catch {
    return undefined;
  }
}

/** JSON object matching `schema`, else `InvalidRequest` (with the txnid if one was readable). */
function parse<T>(schema: z.ZodType<T>, body: Uint8Array): T {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new Refusal('InvalidRequest');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Refusal('InvalidRequest', readTxnid(value));
  }
  return parsed.data;
}

function readTxnid(value: unknown): string {
  const t = z.object({ txnid: z.string() }).safeParse(value);
  return t.success ? t.data.txnid : '';
}

function refusalAsReply(run: () => BankReply): BankReply {
  try {
    return run();
  } catch (e) {
    return asReply(e);
  }
}

async function refusalsAsReplies(run: () => Promise<BankReply>): Promise<BankReply> {
  try {
    return await run();
  } catch (e) {
    return asReply(e);
  }
}

function asReply(e: unknown): BankReply {
  if (e instanceof Refusal) {
    return { ok: false, code: e.code, txnid: e.txnid };
  }
  throw e;
}
