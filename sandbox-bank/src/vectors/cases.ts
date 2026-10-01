/**
 * Builds one test case: every message a session exchanges, signed and
 * encrypted with the test keys (FORMATS §5, §11).
 *
 * Layering rule: the enclave checks AA signature → consent → decrypt → FIP
 * signature. A negative case breaks exactly one layer; every layer outside
 * it is then built normally (re-encrypted, re-signed), so the broken layer
 * is the one that fails.
 */

import { createHash, createHmac } from 'node:crypto';

import { b64Decode, b64Encode, b64urlDecode, b64urlEncode, utf8 } from '../crypto/encoding.ts';
import { deriveSessionKey, encrypt } from '../crypto/cipher.ts';
import { sessionKeyPairFromScalar, type KeyMode, type SessionKeyPair } from '../crypto/ecdh.ts';
import type { JsonValue } from '../crypto/jcs.ts';
import { encodeDetached, rsaSigner, signCompact, signDetached, type Alg } from '../crypto/jws.ts';
import { buildConsent } from '../rebit/consent.ts';
import { buildFetchResponse, buildFipEnvelope } from '../rebit/fetch-response.ts';
import { buildFiRequest } from '../rebit/fi-request.ts';
import { buildKeyMaterial, isoUtc } from '../rebit/key-material.ts';
import { reduceFi } from '../scoring/reduce.ts';
import { score, type Features } from '../scoring/score.ts';
import { ENCLAVE_KEY_FILE, type TestKeys } from './keys.ts';
import { NOW_UNIX, type Persona } from './personas.ts';
import { DEFAULT_POLICY, policyHashHex } from './policy.ts';
import { seedBytes, uuidFromSeed } from './prng.ts';

export type NegativeId =
  | 'fetch_response_flipped'
  | 'ciphertext_flipped'
  | 'fi_plaintext_changed'
  | 'consent_tampered'
  | 'consent_not_active'
  | 'unpinned_aa_key'
  | 'alg_none'
  | 'alg_hs256'
  | 'detached_no_crit';

export type ErrorCode =
  | 'bad_aa_signature'
  | 'decrypt_failed'
  | 'bad_fip_signature'
  | 'bad_consent_signature'
  | 'consent_invalid'
  | 'unknown_kid'
  | 'bad_alg'
  | 'bad_header';

export const NEGATIVE_CASES: readonly { readonly id: NegativeId; readonly errorCode: ErrorCode }[] =
  [
    { id: 'fetch_response_flipped', errorCode: 'bad_aa_signature' },
    { id: 'ciphertext_flipped', errorCode: 'decrypt_failed' },
    { id: 'fi_plaintext_changed', errorCode: 'bad_fip_signature' },
    { id: 'consent_tampered', errorCode: 'bad_consent_signature' },
    { id: 'consent_not_active', errorCode: 'consent_invalid' },
    { id: 'unpinned_aa_key', errorCode: 'unknown_kid' },
    { id: 'alg_none', errorCode: 'bad_alg' },
    { id: 'alg_hs256', errorCode: 'bad_alg' },
    { id: 'detached_no_crit', errorCode: 'bad_header' },
  ];

export interface CaseOptions {
  readonly mode: KeyMode;
  readonly aaAlg: Alg;
  readonly negative?: NegativeId;
}

export type CaseFiles = ReadonlyMap<string, Uint8Array>;

const DAY = 86_400;
const KEY_TTL = DAY;
const WINDOW_DAYS = 365;

/** Per-case fixed values: ids, nonces, window. All derived from the case id. */
interface Context {
  readonly caseId: string;
  readonly persona: Persona;
  readonly keys: TestKeys;
  readonly opts: CaseOptions;
  readonly enclave: SessionKeyPair;
  readonly enclaveNonce: Uint8Array;
  readonly txnid: string;
  readonly windowFrom: number;
  readonly windowTo: number;
}

export function buildCase(
  caseId: string,
  persona: Persona,
  keys: TestKeys,
  opts: CaseOptions,
): CaseFiles {
  const windowTo = NOW_UNIX - (NOW_UNIX % DAY);
  const ctx: Context = {
    caseId,
    persona,
    keys,
    opts,
    enclave: sessionKeyPairFromScalar(opts.mode, keys.enclaveScalar),
    enclaveNonce: seedBytes(caseId, 'enclave_nonce'),
    txnid: uuidFromSeed(seedBytes(caseId, 'txnid')),
    windowFrom: windowTo - WINDOW_DAYS * DAY,
    windowTo,
  };
  const consentJws = buildConsentJws(ctx);
  const fiRequestBody = buildFiRequestBody(ctx, consentJws);
  const fetchBody = buildFetchBody(ctx);
  return new Map([
    ['session.json', jsonBytes(sessionJson(ctx))],
    ['fi_request.body', fiRequestBody],
    ['fi_request.jws', utf8(signDetached(fiRequestBody, keys.fiu))],
    ['fetch_response.body', tamperFetchBody(ctx, fetchBody)],
    ['fetch_response.jws', utf8(signFetchResponse(ctx, fetchBody))],
    ['consent.jws', utf8(consentJws)],
    ['expected.json', jsonBytes(expectedJson(ctx, consentJws))],
  ]);
}

function buildConsentJws(ctx: Context): string {
  const consent = buildConsent({
    consentId: uuidFromSeed(seedBytes(ctx.caseId, 'consent_id')),
    status: ctx.opts.negative === 'consent_not_active' ? 'REVOKED' : 'ACTIVE',
    start: isoUtc(NOW_UNIX - DAY),
    expiry: isoUtc(NOW_UNIX + WINDOW_DAYS * DAY),
    from: isoUtc(ctx.windowFrom),
    to: isoUtc(ctx.windowTo),
  });
  const jws = signCompact(utf8(JSON.stringify(consent)), ctx.keys.aa, ctx.opts.aaAlg);
  return ctx.opts.negative === 'consent_tampered' ? tamperCompactPayload(jws) : jws;
}

function buildFiRequestBody(ctx: Context, consentJws: string): Uint8Array {
  const [, , consentSignature = ''] = consentJws.split('.');
  const consentId = uuidFromSeed(seedBytes(ctx.caseId, 'consent_id'));
  const request = buildFiRequest({
    txnid: ctx.txnid,
    timestamp: isoUtc(NOW_UNIX),
    consentId,
    consentSignature,
    from: isoUtc(ctx.windowFrom),
    to: isoUtc(ctx.windowTo),
    keyMaterial: buildKeyMaterial(ctx.enclave.publicSpki, ctx.enclaveNonce, NOW_UNIX + KEY_TTL),
  });
  return jsonBytes(request, 0);
}

/** FIP side: sign the FI, wrap it, encrypt to the enclave's session key. */
function buildFetchBody(ctx: Context): Uint8Array {
  const fip = sessionKeyPairFromScalar(ctx.opts.mode, seedBytes(ctx.caseId, 'fip_scalar'));
  const fipNonce = seedBytes(ctx.caseId, 'fip_nonce');
  const fiBytes = jsonBytes(ctx.persona.fi, 0);
  const fipJws = signDetached(fiBytes, ctx.keys.fip);
  const envelopeFi =
    ctx.opts.negative === 'fi_plaintext_changed' ? changedFi(ctx.persona.fi) : fiBytes;
  const key = deriveSessionKey(
    fip.sharedSecret(ctx.enclave.publicSpki),
    fipNonce,
    ctx.enclaveNonce,
  );
  const encrypted = encrypt(key, jsonBytes(buildFipEnvelope(envelopeFi, fipJws), 0));
  const response = buildFetchResponse({
    txnid: ctx.txnid,
    timestamp: isoUtc(NOW_UNIX),
    linkRefNumber: uuidFromSeed(seedBytes(ctx.caseId, 'link_ref')),
    maskedAccNumber: 'XXXXXXXX1234',
    encryptedFi: ctx.opts.negative === 'ciphertext_flipped' ? flipB64Byte(encrypted) : encrypted,
    keyMaterial: buildKeyMaterial(fip.publicSpki, fipNonce, NOW_UNIX + KEY_TTL),
  });
  return jsonBytes(response, 0);
}

/** The AA's detached JWS over the fetch-response bytes, or its broken variant. */
function signFetchResponse(ctx: Context, body: Uint8Array): string {
  const { aa, rogue } = ctx.keys;
  const alg = ctx.opts.aaAlg;
  switch (ctx.opts.negative) {
    case 'unpinned_aa_key':
      return signDetached(body, rogue, alg);
    case 'alg_none':
      return encodeDetached(
        { alg: 'none', kid: aa.kid, b64: false, crit: ['b64'] },
        body,
        () => new Uint8Array(0),
      );
    case 'alg_hs256':
      return encodeDetached(
        { alg: 'HS256', kid: aa.kid, b64: false, crit: ['b64'] },
        body,
        (input) =>
          new Uint8Array(
            createHmac('sha256', seedBytes(ctx.caseId, 'hmac_key')).update(input).digest(),
          ),
      );
    case 'detached_no_crit':
      return encodeDetached({ alg, kid: aa.kid, b64: false }, body, rsaSigner(aa.privateKey, alg));
    // Cases broken at another layer: the AA signature itself stays valid.
    case undefined:
    case 'fetch_response_flipped':
    case 'ciphertext_flipped':
    case 'fi_plaintext_changed':
    case 'consent_tampered':
    case 'consent_not_active':
      break;
  }
  return signDetached(body, aa, alg);
}

/** Flips one byte of the signed fetch response (after signing): `"ver":"1.1.3"` → `1.1.4`. */
function tamperFetchBody(ctx: Context, body: Uint8Array): Uint8Array {
  if (ctx.opts.negative !== 'fetch_response_flipped') {
    return body;
  }
  const text = Buffer.from(body).toString('utf8');
  return utf8(text.replace('"ver":"1.1.3"', '"ver":"1.1.4"'));
}

/** Changes the consent payload (ACTIVE → ACTIVF) and keeps the old signature. */
function tamperCompactPayload(jws: string): string {
  const [header = '', payload = '', signature = ''] = jws.split('.');
  const text = Buffer.from(b64urlDecode(payload)).toString('utf8');
  const tampered = b64urlEncode(utf8(text.replace('"ACTIVE"', '"ACTIVF"')));
  return `${header}.${tampered}.${signature}`;
}

/** Flips the first ciphertext byte of base64(ct ‖ tag). */
function flipB64Byte(b64: string): string {
  const bytes = b64Decode(b64);
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return b64Encode(bytes);
}

/** Different FI bytes: first transaction's narration changed. */
function changedFi(fi: JsonValue): Uint8Array {
  const text = JSON.stringify(fi);
  return utf8(text.replace('"narration":"', '"narration":"X'));
}

function sessionJson(ctx: Context): JsonValue {
  return {
    case_id: ctx.caseId,
    persona_id: ctx.persona.persona_id,
    mode: ctx.opts.mode,
    aa_alg: ctx.opts.aaAlg,
    enclave_key: `keys/${ENCLAVE_KEY_FILE}`,
    enclave_nonce_b64: b64Encode(ctx.enclaveNonce),
    session_id: uuidFromSeed(seedBytes(ctx.caseId, 'session_id')),
    txnid: ctx.txnid,
    now_unix: NOW_UNIX,
    key_expiry_unix: NOW_UNIX + KEY_TTL,
    fi_data_range: { from: isoUtc(ctx.windowFrom), to: isoUtc(ctx.windowTo) },
  };
}

function expectedJson(ctx: Context, consentJws: string): JsonValue {
  const code = NEGATIVE_CASES.find((c) => c.id === ctx.opts.negative)?.errorCode;
  if (code !== undefined) {
    return { error_code: code };
  }
  return {
    policy_hash: policyHashHex(),
    consent_hash: createHash('sha256').update(consentJws, 'ascii').digest('hex'),
    window_from: ctx.windowFrom,
    window_to: ctx.windowTo,
    ...scoredJson(ctx.persona),
  };
}

/**
 * `tier` and `features` from the independent TS scorer (FORMATS §6.1).
 * Generation fails if the tier isn't the persona's `expected_tier`.
 */
export function scoredJson(persona: Persona): { tier: string; features: JsonValue } {
  const fiText = new TextDecoder().decode(jsonBytes(persona.fi, 0));
  const scores = score(reduceFi(fiText), DEFAULT_POLICY);
  if (scores.outcome !== persona.expected_tier) {
    throw new Error(
      `${persona.persona_id}: TS scorer gave ${scores.outcome}, expected ${persona.expected_tier}`,
    );
  }
  return {
    tier: scores.outcome,
    features: { full: featuresJson(scores.full), recent: featuresJson(scores.recent) },
  };
}

function featuresJson(f: Features): JsonValue {
  return {
    months: f.months,
    income_median_paise: safeInteger(f.income_median_paise),
    obligation_median_paise: safeInteger(f.obligation_median_paise),
    foir_bps: f.foir_bps,
    cv_bps: f.cv_bps,
    loans: f.loans,
    bounces: f.bounces,
    unmatched_emi_bounces: f.unmatched_emi_bounces,
    od_days: f.od_days,
  };
}

/** Paise as a JSON integer; refuses values a JSON reader may not hold exactly. */
function safeInteger(paise: bigint): number {
  if (paise > BigInt(Number.MAX_SAFE_INTEGER) || paise < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`paise ${paise} exceed 2^53 - 1`);
  }
  return Number(paise);
}

/** Compact (indent 0) for signed bodies; 2-space for human-read files. No trailing newline. */
export function jsonBytes(value: JsonValue, indent = 2): Uint8Array {
  return utf8(JSON.stringify(value, null, indent));
}
