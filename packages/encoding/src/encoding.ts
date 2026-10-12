/**
 * Byte encodings used on the wire (FORMATS §0): base64 for ReBIT binary
 * fields, base64url without padding for JWS segments, hex for hashes.
 * Decoders are strict: a lenient decoder would let two different strings
 * map to the same bytes, which breaks "verify the bytes as received".
 *
 * The one encoding module of the TypeScript workspace (CODING-GUIDELINES §3):
 * sandbox-bank, gateway, ops and the verifier use it instead of ad-hoc Node
 * byte-string calls. It uses no Node globals (`atob`/`btoa`/`TextEncoder` only),
 * so the verifier can import it in a browser.
 */

export class EncodingError extends Error {
  override readonly name = 'EncodingError';
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

const HEX_DIGITS = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Bytes → the "binary string" `btoa` consumes (one char per byte). */
function binaryString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return out;
}

function fromBinaryString(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Standard base64 with padding. */
export function b64Encode(bytes: Uint8Array): string {
  return btoa(binaryString(bytes));
}

/** Strict standard base64: padded, canonical (re-encodes to the same string). */
export function b64Decode(s: string): Uint8Array {
  if (!B64_RE.test(s)) {
    throw new EncodingError('invalid base64');
  }
  return canonical(fromBinaryString(atob(s)), s, b64Encode);
}

/** base64url without padding (RFC 7515). */
export function b64urlEncode(bytes: Uint8Array): string {
  return b64Encode(bytes).replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
}

/** Strict base64url: no padding, no stray characters, canonical trailing bits. */
export function b64urlDecode(s: string): Uint8Array {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) {
    throw new EncodingError('invalid base64url');
  }
  const padded = s
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(s.length / 4) * 4, '=');
  return canonical(fromBinaryString(atob(padded)), s, b64urlEncode);
}

/** Lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX_DIGITS[byte];
  return out;
}

/** Hex (either case) to bytes. */
export function fromHex(s: string): Uint8Array {
  if (!HEX_RE.test(s)) {
    throw new EncodingError('invalid hex');
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** UTF-8 bytes of a string. */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Single-line PEM: rahasya rejects the usual 64-column form with newlines,
 * so this is the only form we emit (FORMATS §3).
 */
export function derToSingleLinePem(der: Uint8Array): string {
  return `-----BEGIN PUBLIC KEY-----${b64Encode(der)}-----END PUBLIC KEY-----`;
}

/** Any PEM form (single-line, multi-line, or bare base64) to DER. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  return b64Decode(body);
}

/** Rejects strings whose non-zero trailing bits the decoder silently dropped. */
function canonical(bytes: Uint8Array, s: string, encode: (b: Uint8Array) => string): Uint8Array {
  if (encode(bytes) !== s) {
    throw new EncodingError('non-canonical encoding');
  }
  return bytes;
}
