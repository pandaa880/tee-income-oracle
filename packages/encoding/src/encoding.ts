/**
 * Byte encodings used on the wire (FORMATS §0): base64 for ReBIT binary
 * fields, base64url without padding for JWS segments, hex for hashes.
 * Decoders are strict: a lenient decoder would let two different strings
 * map to the same bytes, which breaks "verify the bytes as received".
 *
 * The one encoding module of the TypeScript workspace (CODING-GUIDELINES §3):
 * sandbox-bank, gateway and ops use it instead of ad-hoc `Buffer` calls.
 */

export class EncodingError extends Error {
  override readonly name = 'EncodingError';
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

/** Standard base64 with padding. */
export function b64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Strict standard base64: padded, canonical (re-encodes to the same string). */
export function b64Decode(s: string): Uint8Array {
  if (!B64_RE.test(s)) {
    throw new EncodingError('invalid base64');
  }
  return canonical(Buffer.from(s, 'base64'), s, b64Encode);
}

/** base64url without padding (RFC 7515). */
export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Strict base64url: no padding, no stray characters, canonical trailing bits. */
export function b64urlDecode(s: string): Uint8Array {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) {
    throw new EncodingError('invalid base64url');
  }
  return canonical(Buffer.from(s, 'base64url'), s, b64urlEncode);
}

/** Lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Hex (either case) to bytes. */
export function fromHex(s: string): Uint8Array {
  if (!HEX_RE.test(s)) {
    throw new EncodingError('invalid hex');
  }
  return new Uint8Array(Buffer.from(s, 'hex'));
}

/** UTF-8 bytes of a string. */
export function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
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

/** Rejects strings whose non-zero trailing bits Buffer silently dropped. */
function canonical(buf: Buffer, s: string, encode: (b: Uint8Array) => string): Uint8Array {
  if (encode(buf) !== s) {
    throw new EncodingError('non-canonical encoding');
  }
  return new Uint8Array(buf);
}
