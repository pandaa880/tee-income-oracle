/**
 * Builds one test case: every message a session exchanges, signed and
 * encrypted with the test keys (FORMATS §5, §11).
 *
 * Layering rule: the enclave checks AA signature → fetch shape → session
 * ids → consent → window → decrypt → FIP signature → FI (FORMATS §10.1).
 * A negative case breaks exactly one layer; every layer outside it is then
 * built normally (re-encrypted, re-signed), so the broken layer is the one
 * that fails.
 */

import { createHash, createHmac } from 'node:crypto';

import {
  b64Decode,
  b64Encode,
  b64urlDecode,
  b64urlEncode,
  toHex,
  utf8,
} from '../crypto/encoding.ts';
import { deriveSessionKey, encrypt } from '../crypto/cipher.ts';
import { sessionKeyPairFromScalar, type KeyMode, type SessionKeyPair } from '../crypto/ecdh.ts';
import type { JsonValue } from '../crypto/jcs.ts';
import { encodeDetached, rsaSigner, signCompact, signDetached, type Alg } from '../crypto/jws.ts';
import { buildConsent } from '../rebit/consent.ts';
import {
  base58Decode,
  base58Encode,
  buildMessage,
  buildPayload,
  type Tier,
} from '../attest/payload.ts';
import {
  buildFetchResponse,
  buildFipEnvelope,
  type ResponseLayout,
} from '../rebit/fetch-response.ts';
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
  | 'detached_no_crit'
  | 'fetch_txnid_mismatch'
  | 'consent_id_mismatch'
  | 'consent_expired'
  | 'consent_not_started'
  | 'window_outside_consent'
  | 'window_too_short'
  | 'window_stale'
  | 'statement_outside_window'
  | 'statement_too_short'
  | 'multi_fip_response'
  | 'multi_account_response'
  | 'fip_envelope_malformed'
  | 'amount_three_decimals'
  | 'amount_negative_string'
  | 'fi_xml'
  | 'order_txnid_before_decrypt'
  | 'order_stale_before_decrypt';

export type ErrorCode =
  | 'bad_aa_signature'
  | 'decrypt_failed'
  | 'bad_fip_signature'
  | 'bad_consent_signature'
  | 'consent_invalid'
  | 'unknown_kid'
  | 'bad_alg'
  | 'bad_header'
  | 'session_mismatch'
  | 'window_mismatch'
  | 'window_too_short'
  | 'window_stale'
  | 'bad_fetch_response'
  | 'bad_fip_envelope'
  | 'bad_fi_data'
  | 'unsupported_fi_format';

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
    { id: 'fetch_txnid_mismatch', errorCode: 'session_mismatch' },
    { id: 'consent_id_mismatch', errorCode: 'session_mismatch' },
    { id: 'consent_expired', errorCode: 'consent_invalid' },
    { id: 'consent_not_started', errorCode: 'consent_invalid' },
    { id: 'window_outside_consent', errorCode: 'window_mismatch' },
    { id: 'window_too_short', errorCode: 'window_too_short' },
    { id: 'window_stale', errorCode: 'window_stale' },
    { id: 'statement_outside_window', errorCode: 'window_mismatch' },
    { id: 'statement_too_short', errorCode: 'window_too_short' },
    { id: 'multi_fip_response', errorCode: 'bad_fetch_response' },
    { id: 'multi_account_response', errorCode: 'bad_fetch_response' },
    { id: 'fip_envelope_malformed', errorCode: 'bad_fip_envelope' },
    { id: 'amount_three_decimals', errorCode: 'bad_fi_data' },
    { id: 'amount_negative_string', errorCode: 'bad_fi_data' },
    { id: 'fi_xml', errorCode: 'unsupported_fi_format' },
    { id: 'order_txnid_before_decrypt', errorCode: 'session_mismatch' },
    { id: 'order_stale_before_decrypt', errorCode: 'window_stale' },
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
const ATTEST_TTL = 600;
const ORACLE_PROGRAM_ID = 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8';
/** Seed namespace of the ids all cases share: one deployment, one SAS credential and schema. */
const DEPLOYMENT = 'deployment';

/** Requested range: ends `endDaysAgo` days before today (UTC), `days` long. Default 0 / 365. */
const REQUESTED_RANGES: Partial<
  Record<NegativeId, { readonly endDaysAgo: number; readonly days: number }>
> = {
  window_too_short: { endDaysAgo: 0, days: 179 },
  window_stale: { endDaysAgo: 8, days: WINDOW_DAYS },
  order_stale_before_decrypt: { endDaysAgo: 8, days: WINDOW_DAYS },
};

/** Consent validity as offsets from now (seconds). Default: started a day ago, runs a year. */
const CONSENT_TIMES: Partial<
  Record<NegativeId, { readonly start: number; readonly expiry: number }>
> = {
  consent_expired: { start: -2 * DAY, expiry: -DAY },
  consent_not_started: { start: DAY, expiry: (WINDOW_DAYS + 1) * DAY },
};

/** Changes to the FI bytes the FIP signs (the FIP signs the changed bytes: its layer is valid). */
const FI_MUTATIONS: Partial<Record<NegativeId, (ctx: Context) => Uint8Array>> = {
  statement_outside_window: (ctx) => {
    const day = isoUtc(ctx.windowFrom - DAY).slice(0, 10);
    return utf8(personaFiText(ctx).replace(/"startDate":"[^"]*"/, `"startDate":"${day}"`));
  },
  // A 30-day statement (endDate − 29 days .. endDate) under the full-year request. The
  // transactions before the new startDate are kept: check 15 fires before scoring, so the
  // enclave never looks at them.
  statement_too_short: (ctx) => {
    const day = isoUtc(NOW_UNIX - 29 * DAY).slice(0, 10);
    return utf8(personaFiText(ctx).replace(/"startDate":"[^"]*"/, `"startDate":"${day}"`));
  },
  amount_three_decimals: (ctx) => withFirstAmount(personaFiText(ctx), '1234.567'),
  amount_negative_string: (ctx) => withFirstAmount(personaFiText(ctx), '"-0.50"'),
  fi_xml: () =>
    utf8(
      '<Account xmlns="http://api.rebit.org.in/FIP/jsonSchema/deposit" type="deposit"></Account>',
    ),
};

const LAYOUTS: Partial<Record<NegativeId, ResponseLayout>> = {
  multi_fip_response: 'two_fips',
  multi_account_response: 'two_accounts',
};

/** Negatives whose ciphertext is broken on purpose (the order cases hide it behind an earlier failure). */
const FLIPPED_CIPHERTEXT: readonly (NegativeId | undefined)[] = [
  'ciphertext_flipped',
  'order_txnid_before_decrypt',
  'order_stale_before_decrypt',
];

/** Negatives whose fetch response names a txnid other than the session's. */
const OTHER_TXNID: readonly (NegativeId | undefined)[] = [
  'fetch_txnid_mismatch',
  'order_txnid_before_decrypt',
];

/** Per-case fixed values: ids, nonces, window. All derived from the case id. */
interface Context {
  readonly caseId: string;
  readonly persona: Persona;
  readonly keys: TestKeys;
  readonly opts: CaseOptions;
  readonly enclave: SessionKeyPair;
  readonly enclaveNonce: Uint8Array;
  readonly txnid: string;
  readonly consentId: string;
  /** The enclave's FI request range (session.json `fi_data_range`). */
  readonly windowFrom: number;
  readonly windowTo: number;
  /** The range the consent grants (usually equal to the requested one). */
  readonly consentFrom: number;
  readonly consentTo: number;
}

export function buildCase(
  caseId: string,
  persona: Persona,
  keys: TestKeys,
  opts: CaseOptions,
): CaseFiles {
  const range = requestedRange(opts.negative);
  const ctx: Context = {
    caseId,
    persona,
    keys,
    opts,
    enclave: sessionKeyPairFromScalar(opts.mode, keys.enclaveScalar),
    enclaveNonce: seedBytes(caseId, 'enclave_nonce'),
    txnid: uuidFromSeed(seedBytes(caseId, 'txnid')),
    consentId: uuidFromSeed(seedBytes(caseId, 'consent_id')),
    windowFrom: range.from,
    windowTo: range.to,
    consentFrom: opts.negative === 'window_outside_consent' ? range.from + 30 * DAY : range.from,
    consentTo: range.to,
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

function requestedRange(negative: NegativeId | undefined): { from: number; to: number } {
  const shape = (negative === undefined ? undefined : REQUESTED_RANGES[negative]) ?? {
    endDaysAgo: 0,
    days: WINDOW_DAYS,
  };
  const to = NOW_UNIX - (NOW_UNIX % DAY) - shape.endDaysAgo * DAY;
  return { from: to - shape.days * DAY, to };
}

function buildConsentJws(ctx: Context): string {
  const negative = ctx.opts.negative;
  const times = (negative === undefined ? undefined : CONSENT_TIMES[negative]) ?? {
    start: -DAY,
    expiry: WINDOW_DAYS * DAY,
  };
  const consent = buildConsent({
    consentId:
      negative === 'consent_id_mismatch'
        ? uuidFromSeed(seedBytes(ctx.caseId, 'other_consent_id'))
        : ctx.consentId,
    status: negative === 'consent_not_active' ? 'REVOKED' : 'ACTIVE',
    start: isoUtc(NOW_UNIX + times.start),
    expiry: isoUtc(NOW_UNIX + times.expiry),
    from: isoUtc(ctx.consentFrom),
    to: isoUtc(ctx.consentTo),
  });
  const jws = signCompact(utf8(JSON.stringify(consent)), ctx.keys.aa, ctx.opts.aaAlg);
  return ctx.opts.negative === 'consent_tampered' ? tamperCompactPayload(jws) : jws;
}

function buildFiRequestBody(ctx: Context, consentJws: string): Uint8Array {
  const [, , consentSignature = ''] = consentJws.split('.');
  const request = buildFiRequest({
    txnid: ctx.txnid,
    timestamp: isoUtc(NOW_UNIX),
    consentId: ctx.consentId,
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
  const fiBytes = signedFiBytes(ctx);
  const fipJws = signDetached(fiBytes, ctx.keys.fip);
  const envelopeFi =
    ctx.opts.negative === 'fi_plaintext_changed' ? changedFi(ctx.persona.fi) : fiBytes;
  const key = deriveSessionKey(
    fip.sharedSecret(ctx.enclave.publicSpki),
    fipNonce,
    ctx.enclaveNonce,
  );
  const envelope =
    ctx.opts.negative === 'fip_envelope_malformed'
      ? { fi: 'not base64 !', jws: fipJws }
      : buildFipEnvelope(envelopeFi, fipJws);
  const encrypted = encrypt(key, jsonBytes(envelope, 0));
  const response = buildFetchResponse({
    txnid: OTHER_TXNID.includes(ctx.opts.negative)
      ? uuidFromSeed(seedBytes(ctx.caseId, 'other_txnid'))
      : ctx.txnid,
    timestamp: isoUtc(NOW_UNIX),
    linkRefNumber: uuidFromSeed(seedBytes(ctx.caseId, 'link_ref')),
    maskedAccNumber: 'XXXXXXXX1234',
    encryptedFi: FLIPPED_CIPHERTEXT.includes(ctx.opts.negative)
      ? flipB64Byte(encrypted)
      : encrypted,
    keyMaterial: buildKeyMaterial(fip.publicSpki, fipNonce, NOW_UNIX + KEY_TTL),
    layout: (ctx.opts.negative === undefined ? undefined : LAYOUTS[ctx.opts.negative]) ?? 'single',
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
    case 'fetch_txnid_mismatch':
    case 'consent_id_mismatch':
    case 'consent_expired':
    case 'consent_not_started':
    case 'window_outside_consent':
    case 'window_too_short':
    case 'window_stale':
    case 'statement_outside_window':
    case 'statement_too_short':
    case 'multi_fip_response':
    case 'multi_account_response':
    case 'fip_envelope_malformed':
    case 'amount_three_decimals':
    case 'amount_negative_string':
    case 'fi_xml':
    case 'order_txnid_before_decrypt':
    case 'order_stale_before_decrypt':
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

/** The FI bytes the FIP signs: the persona's, or the case's mutation of them. */
function signedFiBytes(ctx: Context): Uint8Array {
  const mutate = ctx.opts.negative === undefined ? undefined : FI_MUTATIONS[ctx.opts.negative];
  return mutate === undefined ? jsonBytes(ctx.persona.fi, 0) : mutate(ctx);
}

function personaFiText(ctx: Context): string {
  return new TextDecoder().decode(jsonBytes(ctx.persona.fi, 0));
}

/** Replaces the first transaction's `amount` value (Summary's own amounts come before it). */
function withFirstAmount(text: string, jsonValue: string): Uint8Array {
  const at = text.indexOf('"Transaction":[');
  const tail = text.slice(at).replace(/"amount":[^,}]*/, `"amount":${jsonValue}`);
  return utf8(text.slice(0, at) + tail);
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
    consent_id: ctx.consentId,
    wallet: base58Encode(seedBytes(ctx.caseId, 'wallet')),
    attest: {
      oracle_program_id: ORACLE_PROGRAM_ID,
      sas_credential: base58Encode(seedBytes(DEPLOYMENT, 'sas_credential')),
      sas_schema: base58Encode(seedBytes(DEPLOYMENT, 'sas_schema')),
      proof_type: 1,
      measurement_id: 0,
      expiry_unix: NOW_UNIX + ATTEST_TTL,
    },
  };
}

function expectedJson(ctx: Context, consentJws: string): JsonValue {
  const code = NEGATIVE_CASES.find((c) => c.id === ctx.opts.negative)?.errorCode;
  if (code !== undefined) {
    return { error_code: code };
  }
  const consentHash = createHash('sha256').update(consentJws, 'ascii').digest();
  const scored = scoredJson(ctx.persona);
  return {
    policy_hash: policyHashHex(),
    consent_hash: consentHash.toString('hex'),
    window_from: ctx.windowFrom,
    window_to: ctx.windowTo,
    ...scored,
    ...attestationJson(ctx, scored.tier, consentHash),
  };
}

/** `payload_hex` / `msg_hex` (§7, §8) from the TS builders; both null when the tier is REJECT. */
function attestationJson(
  ctx: Context,
  tier: string,
  consentHash: Uint8Array,
): { payload_hex: string | null; msg_hex: string | null } {
  if (!isTier(tier)) {
    return { payload_hex: null, msg_hex: null };
  }
  const payload = buildPayload({
    tier,
    proofType: 1,
    measurementId: 0,
    policyHash: new Uint8Array(Buffer.from(policyHashHex(), 'hex')),
    consentHash,
    issuedAt: BigInt(NOW_UNIX),
    windowFrom: ctx.windowFrom,
    windowTo: ctx.windowTo,
  });
  const message = buildMessage(
    {
      oracleProgramId: base58Decode(ORACLE_PROGRAM_ID),
      sasCredential: seedBytes(DEPLOYMENT, 'sas_credential'),
      sasSchema: seedBytes(DEPLOYMENT, 'sas_schema'),
    },
    seedBytes(ctx.caseId, 'wallet'),
    payload,
    BigInt(NOW_UNIX + ATTEST_TTL),
  );
  return { payload_hex: toHex(payload), msg_hex: toHex(message) };
}

function isTier(tier: string): tier is Tier {
  return tier === 'A' || tier === 'B' || tier === 'C';
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
