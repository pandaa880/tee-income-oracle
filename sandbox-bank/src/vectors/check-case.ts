/**
 * TS mirror of the enclave's evaluate checks, outside in: AA signature →
 * consent → decrypt → FIP signature. Tests use it to prove each negative
 * case fails at its own layer and all outer layers pass. The Rust side runs
 * the same order in tio-core/tests/common/mod.rs.
 */

import { b64Decode, pemToDer } from '../crypto/encoding.ts';
import { decrypt, DecryptError, deriveSessionKey } from '../crypto/cipher.ts';
import { KeyError, sessionKeyPairFromScalar, type KeyMode } from '../crypto/ecdh.ts';
import { verifyCompact, verifyDetached, type JwsResult } from '../crypto/jws.ts';
import type { CaseFiles } from './cases.ts';
import { pinned, type TestKeys } from './keys.ts';

export type CheckResult =
  | { readonly ok: true; readonly fi: Uint8Array }
  | { readonly ok: false; readonly code: string };

/** Thrown inside the pipeline to stop at the first failing layer. */
class CheckFailure extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.code = code;
  }
}

export function checkCase(files: CaseFiles, keys: TestKeys): CheckResult {
  try {
    return { ok: true, fi: runChecks(files, keys) };
  } catch (e) {
    if (e instanceof CheckFailure || e instanceof KeyError || e instanceof DecryptError) {
      return { ok: false, code: e.code };
    }
    throw e;
  }
}

function runChecks(files: CaseFiles, keys: TestKeys): Uint8Array {
  const aa = [pinned(keys.aa)];
  const body = file(files, 'fetch_response.body');
  jwsOk(verifyDetached(text(files, 'fetch_response.jws'), body, aa), 'bad_aa_signature');
  const consent = verifyCompact(text(files, 'consent.jws'), aa);
  jwsOk(consent, 'bad_consent_signature');
  if (consent.ok && field(parse(consent.value), 'status') !== 'ACTIVE') {
    throw new CheckFailure('consent_invalid');
  }
  const session = parse(file(files, 'session.json'));
  const entry = firstOf(field(parse(body), 'FI'));
  const keyMaterial = field(entry, 'KeyMaterial');
  // Same order as tio-core/tests/common/mod.rs: peer nonce, then ECDH, then our nonce.
  const peerKey = pemToDer(str(field(field(keyMaterial, 'DHPublicKey'), 'KeyValue')));
  const theirs = nonce(str(field(keyMaterial, 'Nonce')));
  const enclave = sessionKeyPairFromScalar(modeOf(field(session, 'mode')), keys.enclaveScalar);
  const shared = enclave.sharedSecret(peerKey);
  const ours = nonce(str(field(session, 'enclave_nonce_b64')));
  const key = deriveSessionKey(shared, ours, theirs);
  const envelope = parse(decrypt(key, str(field(firstOf(field(entry, 'data')), 'encryptedFI'))));
  const fi = b64Decode(str(field(envelope, 'fi')));
  jwsOk(verifyDetached(str(field(envelope, 'jws')), fi, [pinned(keys.fip)]), 'bad_fip_signature');
  return fi;
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

/** Fixture-shape problems are bugs in the case, not expected codes: plain Error. */
function field(obj: unknown, name: string): unknown {
  if (!isRecord(obj) || !(name in obj)) {
    throw new Error(`case JSON is missing ${name}`);
  }
  return obj[name];
}

function isRecord(v: unknown): v is { readonly [k: string]: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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

function modeOf(value: unknown): KeyMode {
  if (value === 'wei25519' || value === 'x25519') {
    return value;
  }
  throw new Error(`unknown mode ${String(value)}`);
}
