/**
 * TS mirror of the enclave's `tio_core::evaluate` check order (plan "Check
 * order", FORMATS §10.1): AA signature → fetch shape → txnid → consent
 * signature → consent parse → consent id → consent status and time → requested
 * range ⊆ consent → too short → stale → decrypt → FIP envelope → FIP signature
 * → FI parse → statement inside range → score. Tests use it to prove each
 * negative case fails at its own layer and every layer before it passes.
 */

import { b64Decode, pemToDer } from '../crypto/encoding.ts';
import { decrypt, DecryptError, deriveSessionKey } from '../crypto/cipher.ts';
import { KeyError, sessionKeyPairFromScalar, type KeyMode } from '../crypto/ecdh.ts';
import { verifyCompact, verifyDetached, type JwsResult } from '../crypto/jws.ts';
import { reduceFi, type MiniFi } from '../scoring/reduce.ts';
import { score, ScoreError } from '../scoring/score.ts';
import type { CaseFiles } from './cases.ts';
import { pinned, type TestKeys } from './keys.ts';
import { DEFAULT_POLICY } from './policy.ts';

export type CheckResult =
  | { readonly ok: true; readonly fi: Uint8Array }
  | { readonly ok: false; readonly code: string };

const DAY = 86_400;
const IST_OFFSET_S = 19_800;

/** Thrown inside the pipeline to stop at the first failing layer. */
class CheckFailure extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.code = code;
  }
}

/** What the enclave remembers about the session (session.json). */
interface Session {
  readonly mode: KeyMode;
  readonly nonceB64: string;
  readonly txnid: string;
  readonly consentId: string;
  readonly now: number;
  readonly from: number;
  readonly to: number;
}

interface Consent {
  readonly id: string;
  readonly status: string;
  readonly fiTypes: readonly unknown[];
  readonly start: number;
  readonly expiry: number;
  readonly from: number;
  readonly to: number;
}

export function checkCase(files: CaseFiles, keys: TestKeys): CheckResult {
  try {
    return { ok: true, fi: runChecks(files, keys) };
  } catch (e) {
    if (
      e instanceof CheckFailure ||
      e instanceof KeyError ||
      e instanceof DecryptError ||
      e instanceof ScoreError
    ) {
      return { ok: false, code: e.code };
    }
    throw e;
  }
}

function runChecks(files: CaseFiles, keys: TestKeys): Uint8Array {
  const aa = [pinned(keys.aa)];
  const session = readSession(parse(file(files, 'session.json')));
  const body = file(files, 'fetch_response.body');
  jwsOk(verifyDetached(text(files, 'fetch_response.jws'), body, aa), 'bad_aa_signature');
  const entry = fetchEntry(body, session);
  const consentJws = verifyCompact(text(files, 'consent.jws'), aa);
  jwsOk(consentJws, 'bad_consent_signature');
  if (consentJws.ok) {
    checkConsent(readConsent(parse(consentJws.value)), session);
  }
  const fi = openEnvelope(entry, session, keys);
  const mini = parseFi(fi);
  checkStatementInRange(mini, session);
  score(mini, DEFAULT_POLICY);
  return fi;
}

/** Steps 2 and 3: fetch response shape (one FI, one account), then txnid. Returns the FI entry. */
function fetchEntry(body: Uint8Array, session: Session): unknown {
  const response = parseOrFail(body, 'bad_fetch_response');
  const fiList = field(response, 'FI');
  const txnid = field(response, 'txnid');
  if (typeof txnid !== 'string' || !Array.isArray(fiList) || fiList.length !== 1) {
    throw new CheckFailure('bad_fetch_response');
  }
  const entry: unknown = fiList[0];
  const data = field(entry, 'data');
  const encrypted = Array.isArray(data) && data.length === 1 ? field(data[0], 'encryptedFI') : null;
  if (typeof encrypted !== 'string' || !isRecord(field(entry, 'KeyMaterial'))) {
    throw new CheckFailure('bad_fetch_response');
  }
  if (txnid !== session.txnid) {
    throw new CheckFailure('session_mismatch');
  }
  return entry;
}

/** Steps 6-10: ids, status, time, requested range against the consent, policy window. */
function checkConsent(consent: Consent, session: Session): void {
  if (consent.id !== session.consentId) {
    throw new CheckFailure('session_mismatch');
  }
  const active = consent.status === 'ACTIVE' && consent.fiTypes.includes('DEPOSIT');
  if (!active || consent.start > session.now || session.now >= consent.expiry) {
    throw new CheckFailure('consent_invalid');
  }
  if (session.from < consent.from || session.to > consent.to) {
    throw new CheckFailure('window_mismatch');
  }
  const { min_days, max_age_days } = DEFAULT_POLICY.window;
  const from = floorToDay(session.from);
  const to = floorToDay(session.to);
  if (to - from < min_days * DAY) {
    throw new CheckFailure('window_too_short');
  }
  if (session.now - to > max_age_days * DAY) {
    throw new CheckFailure('window_stale');
  }
}

/** Steps 11-13: key exchange, decrypt, envelope shape, FIP signature. Returns the FI bytes. */
function openEnvelope(entry: unknown, session: Session, keys: TestKeys): Uint8Array {
  const keyMaterial = field(entry, 'KeyMaterial');
  // Same order as tio-core: peer nonce, then ECDH, then our nonce.
  const peerKey = pemToDer(str(field(field(keyMaterial, 'DHPublicKey'), 'KeyValue')));
  const theirs = nonce(str(field(keyMaterial, 'Nonce')));
  const enclave = sessionKeyPairFromScalar(session.mode, keys.enclaveScalar);
  const shared = enclave.sharedSecret(peerKey);
  const key = deriveSessionKey(shared, nonce(session.nonceB64), theirs);
  const encrypted = str(field(firstOf(field(entry, 'data')), 'encryptedFI'));
  const envelope = parseOrFail(decrypt(key, encrypted), 'bad_fip_envelope');
  const fiB64 = field(envelope, 'fi');
  const jws = field(envelope, 'jws');
  if (typeof fiB64 !== 'string' || typeof jws !== 'string') {
    throw new CheckFailure('bad_fip_envelope');
  }
  const fi = decodeFi(fiB64);
  jwsOk(verifyDetached(jws, fi, [pinned(keys.fip)]), 'bad_fip_signature');
  return fi;
}

function decodeFi(b64: string): Uint8Array {
  try {
    return b64Decode(b64);
  } catch (cause) {
    throw new CheckFailure('bad_fip_envelope', { cause });
  }
}

/** Step 14: XML is a known but unsupported format; anything else the reducer rejects is bad data. */
function parseFi(fi: Uint8Array): MiniFi {
  const fiText = Buffer.from(fi).toString('utf8');
  if (fiText.trimStart().startsWith('<')) {
    throw new CheckFailure('unsupported_fi_format');
  }
  try {
    const mini = reduceFi(fiText);
    if (mini.txns.some((t) => t.amount < 0n)) {
      throw new Error('negative amount');
    }
    return mini;
  } catch (cause) {
    throw new CheckFailure('bad_fi_data', { cause });
  }
}

/** Step 15: the statement's India days lie inside the requested range's India days. */
function checkStatementInRange(mini: MiniFi, session: Session): void {
  if (mini.startDay < indiaDay(floorToDay(session.from))) {
    throw new CheckFailure('window_mismatch');
  }
  if (mini.endDay > indiaDay(floorToDay(session.to))) {
    throw new CheckFailure('window_mismatch');
  }
}

function floorToDay(unix: number): number {
  return Math.floor(unix / DAY) * DAY;
}

function indiaDay(unix: number): number {
  return Math.floor((unix + IST_OFFSET_S) / DAY);
}

function readSession(json: unknown): Session {
  const range = field(json, 'fi_data_range');
  return {
    mode: modeOf(field(json, 'mode')),
    nonceB64: str(field(json, 'enclave_nonce_b64')),
    txnid: str(field(json, 'txnid')),
    consentId: str(field(json, 'consent_id')),
    now: num(field(json, 'now_unix')),
    from: unixOf(str(field(range, 'from'))),
    to: unixOf(str(field(range, 'to'))),
  };
}

/** Step 5: any wrong type or missing member is `consent_invalid`. */
function readConsent(json: unknown): Consent {
  const range = field(json, 'FIDataRange');
  const fiTypes = field(json, 'fiTypes');
  const parts = [
    field(json, 'consentId'),
    field(json, 'status'),
    field(json, 'consentStart'),
    field(json, 'consentExpiry'),
    field(range, 'from'),
    field(range, 'to'),
  ];
  if (!parts.every((p) => typeof p === 'string') || !Array.isArray(fiTypes)) {
    throw new CheckFailure('consent_invalid');
  }
  const [id = '', status = '', start = '', expiry = '', from = '', to = ''] = parts.map(String);
  const consent = {
    id,
    status,
    fiTypes,
    start: unixOf(start),
    expiry: unixOf(expiry),
    from: unixOf(from),
    to: unixOf(to),
  };
  if (!(consent.from < consent.to)) {
    throw new CheckFailure('consent_invalid');
  }
  return consent;
}

/** A signature failure takes the layer's name; other JWS codes pass through. */
function jwsOk(result: JwsResult<unknown>, layerCode: string): void {
  if (!result.ok) {
    throw new CheckFailure(result.code === 'bad_signature' ? layerCode : result.code);
  }
}

/** Like tio-core's `Nonce::from_base64`: bad base64 is `bad_nonce` (length is checked later). */
function nonce(b64: string): Uint8Array {
  try {
    return b64Decode(b64);
  } catch (cause) {
    throw new CheckFailure('bad_nonce', { cause });
  }
}

function file(files: CaseFiles, name: string): Uint8Array {
  const bytes = files.get(name);
  if (bytes === undefined) {
    throw new Error(`case is missing ${name}`);
  }
  return bytes;
}

function text(files: CaseFiles, name: string): string {
  return Buffer.from(file(files, name)).toString('utf8');
}

function parse(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

/** Parses JSON that the enclave must accept as a document; a syntax error fails with `code`. */
function parseOrFail(bytes: Uint8Array, code: string): unknown {
  try {
    return parse(bytes);
  } catch (cause) {
    throw new CheckFailure(code, { cause });
  }
}

/** ReBIT timestamp (ISO, `Z`) in whole seconds; a bad one is a `consent_invalid` consent. */
function unixOf(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new CheckFailure('consent_invalid');
  }
  return Math.floor(ms / 1000);
}

/** `value[name]`, or undefined when `value` is not an object: callers decide what that means. */
function field(obj: unknown, name: string): unknown {
  return isRecord(obj) ? obj[name] : undefined;
}

function isRecord(v: unknown): v is { readonly [k: string]: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fixture-shape problems are bugs in the case, not expected codes: plain Error. */
function firstOf(value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('case JSON: expected a non-empty array');
  }
  return value[0];
}

function str(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('case JSON: expected a string');
  }
  return value;
}

function num(value: unknown): number {
  if (typeof value !== 'number') {
    throw new Error('case JSON: expected a number');
  }
  return value;
}

function modeOf(value: unknown): KeyMode {
  if (value === 'wei25519' || value === 'x25519') {
    return value;
  }
  throw new Error(`unknown mode ${String(value)}`);
}
