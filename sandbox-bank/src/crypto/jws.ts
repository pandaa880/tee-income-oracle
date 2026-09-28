/**
 * JWS, RS256/RS512 only (FORMATS §4): detached with an unencoded payload
 * (RFC 7797) for API bodies, compact for the consent artefact.
 *
 * The verifier mirrors tio-core::jws check for check and in the same order
 * (segments → header → alg → b64/crit/embedded keys → kid → signature), so a
 * negative vector reports the same code on both sides.
 */

import { createSign, createVerify, type KeyObject } from 'node:crypto';

import { b64urlDecode, b64urlEncode, EncodingError, utf8 } from './encoding.ts';
import type { JsonValue } from './jcs.ts';

export type Alg = 'RS256' | 'RS512';
export type JwsHeader = { readonly [k: string]: JsonValue };
export type Signer = (signingInput: Uint8Array) => Uint8Array;

export interface RsaKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export interface PinnedKey {
  readonly kid: string;
  readonly publicKey: KeyObject;
}

export type JwsErrorCode = 'bad_jws' | 'bad_header' | 'bad_alg' | 'unknown_kid' | 'bad_signature';
export type JwsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: JwsErrorCode };

const DIGEST: Readonly<Record<Alg, string>> = { RS256: 'sha256', RS512: 'sha512' };
/** Members we act on: a repeat is rejected so parsers can't disagree on which counts. */
const ACTED_ON = ['alg', 'kid', 'b64', 'crit', 'jwk', 'jku', 'x5u', 'x5c'] as const;
const KEY_CARRYING = ['jwk', 'jku', 'x5u', 'x5c'] as const;

type Form = 'detached' | 'compact';

/** RSASSA-PKCS1-v1_5 signer (deterministic). */
export function rsaSigner(privateKey: KeyObject, alg: Alg): Signer {
  return (signingInput) => {
    const signer = createSign(DIGEST[alg]);
    signer.update(signingInput);
    return new Uint8Array(signer.sign(privateKey));
  };
}

/** `b64url(header)..b64url(sig)`; signs `b64url(header) "." body`. */
export function encodeDetached(header: JwsHeader, body: Uint8Array, sign: Signer): string {
  const h = b64urlEncode(utf8(JSON.stringify(header)));
  return `${h}..${b64urlEncode(sign(concat(utf8(`${h}.`), body)))}`;
}

/** `b64url(header).b64url(payload).b64url(sig)`. */
export function encodeCompact(header: JwsHeader, payload: Uint8Array, sign: Signer): string {
  const input = `${b64urlEncode(utf8(JSON.stringify(header)))}.${b64urlEncode(payload)}`;
  return `${input}.${b64urlEncode(sign(utf8(input)))}`;
}

/** Our detached header: `{"alg","kid","b64":false,"crit":["b64"]}`. */
export function signDetached(body: Uint8Array, key: RsaKey, alg: Alg = 'RS256'): string {
  const header = { alg, kid: key.kid, b64: false, crit: ['b64'] };
  return encodeDetached(header, body, rsaSigner(key.privateKey, alg));
}

/** Our compact header: `{"alg","kid"}`. */
export function signCompact(payload: Uint8Array, key: RsaKey, alg: Alg = 'RS256'): string {
  return encodeCompact({ alg, kid: key.kid }, payload, rsaSigner(key.privateKey, alg));
}

/** Verifies a detached JWS over `body`, the raw bytes as received. */
export function verifyDetached(
  jws: string,
  body: Uint8Array,
  keys: readonly PinnedKey[],
): JwsResult<null> {
  const seg = split(jws);
  if (seg === undefined || seg.payload !== '') {
    return fail('bad_jws');
  }
  const code = verifySegments(seg, 'detached', concat(utf8(`${seg.header}.`), body), keys);
  return code === undefined ? { ok: true, value: null } : fail(code);
}

/** Verifies a compact JWS; returns the decoded payload only after the signature checks. */
export function verifyCompact(jws: string, keys: readonly PinnedKey[]): JwsResult<Uint8Array> {
  const seg = split(jws);
  if (seg === undefined || seg.payload === '') {
    return fail('bad_jws');
  }
  const code = verifySegments(seg, 'compact', utf8(`${seg.header}.${seg.payload}`), keys);
  if (code !== undefined) {
    return fail(code);
  }
  const payload = tryDecode(seg.payload);
  return payload === undefined ? fail('bad_jws') : { ok: true, value: payload };
}

interface Segments {
  readonly header: string;
  readonly payload: string;
  readonly signature: Uint8Array;
}

function split(jws: string): Segments | undefined {
  const parts = jws.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  const [header = '', payload = '', sig = ''] = parts;
  const signature = tryDecode(sig);
  return signature === undefined ? undefined : { header, payload, signature };
}

function verifySegments(
  seg: Segments,
  form: Form,
  signingInput: Uint8Array,
  keys: readonly PinnedKey[],
): JwsErrorCode | undefined {
  const headerBytes = tryDecode(seg.header);
  if (headerBytes === undefined) {
    return 'bad_jws';
  }
  const header = parseHeader(headerBytes);
  const alg = header?.['alg'];
  if (header === undefined || typeof alg !== 'string') {
    return 'bad_header';
  }
  if (alg !== 'RS256' && alg !== 'RS512') {
    return 'bad_alg';
  }
  const kid = header['kid'];
  if (!formOk(header, form) || typeof kid !== 'string') {
    return 'bad_header';
  }
  const key = keys.find((k) => k.kid === kid);
  if (key === undefined) {
    return 'unknown_kid';
  }
  return verifySignature(key.publicKey, alg, signingInput, seg.signature)
    ? undefined
    : 'bad_signature';
}

/**
 * The header as a JSON object, or undefined wherever tio-core's typed serde
 * `Header` fails (→ `bad_header`, before `alg` is looked at): invalid UTF-8,
 * not an object, a repeated member we act on, or a member of the wrong type.
 */
function parseHeader(bytes: Uint8Array): { readonly [k: string]: unknown } | undefined {
  let value: unknown;
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || hasRepeatedMember(text) || !membersTyped(value)) {
    return undefined;
  }
  return value;
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * JSON.parse silently keeps the last of two equal members; serde rejects
 * the repeat. Compare top-level member names after unescaping, so
 * `"alg"` counts as `alg` and a nested `"alg"` doesn't count.
 */
function hasRepeatedMember(text: string): boolean {
  const names = topLevelNames(text);
  return ACTED_ON.some((m) => names.filter((n) => n === m).length > 1);
}

/** Member names of the outer object of already-valid JSON text. */
function topLevelNames(text: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      const name: unknown = JSON.parse(text.slice(i, end + 1));
      if (depth === 1 && /^\s*:/.test(text.slice(end + 1)) && typeof name === 'string') {
        names.push(name);
      }
      i = end;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
    }
  }
  return names;
}

/** Index of the closing quote of the string starting at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    i += text[i] === '\\' ? 2 : 1;
  }
  return i;
}

/** serde's types: alg string; kid string|null; b64 bool|null; crit string[]|null. */
function membersTyped(h: { readonly [k: string]: unknown }): boolean {
  const optional = (name: string, ok: (v: unknown) => boolean): boolean =>
    !(name in h) || h[name] === null || ok(h[name]);
  return (
    typeof h['alg'] === 'string' &&
    optional('kid', (v) => typeof v === 'string') &&
    optional('b64', (v) => typeof v === 'boolean') &&
    optional('crit', (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'))
  );
}

function isRecord(v: unknown): v is { readonly [k: string]: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Detached: b64 exactly false and crit exactly ["b64"]. Compact: neither present. No embedded keys. */
function formOk(header: { readonly [k: string]: unknown }, form: Form): boolean {
  if (KEY_CARRYING.some((m) => m in header)) {
    return false;
  }
  if (form === 'compact') {
    return !('b64' in header) && !('crit' in header);
  }
  const crit = header['crit'];
  return header['b64'] === false && Array.isArray(crit) && crit.length === 1 && crit[0] === 'b64';
}

function verifySignature(key: KeyObject, alg: Alg, input: Uint8Array, sig: Uint8Array): boolean {
  const verifier = createVerify(DIGEST[alg]);
  verifier.update(input);
  return verifier.verify(key, sig);
}

function tryDecode(s: string): Uint8Array | undefined {
  try {
    return b64urlDecode(s);
  } catch (e) {
    if (e instanceof EncodingError) {
      return undefined;
    }
    throw e;
  }
}

function fail(code: JwsErrorCode): { readonly ok: false; readonly code: JwsErrorCode } {
  return { ok: false, code };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
