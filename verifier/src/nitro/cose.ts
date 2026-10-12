/**
 * COSE_Sign1 (RFC 9052 §4.2) as AWS Nitro emits it: an untagged 4-element array
 * `[protected, unprotected, payload, signature]`, protected header exactly
 * `{1: -35}` (ES384), signature the raw `r ‖ s` of P-384 (96 bytes).
 *
 * The payload is kept as the exact bytes the enclave signed. Nitro encodes it as
 * an indefinite-length map, so re-encoding it canonically would change the bytes
 * and break the signature: everything downstream decodes the bytes, never
 * re-serializes them.
 */
import { p384 } from '@noble/curves/nist.js';
import { sha384 } from '@noble/hashes/sha2.js';
import { decode, encode } from 'cborg';
import { equalBytes } from '../bytes.ts';
import { VerifierError } from '../errors.ts';

export type CoseSign1 = {
  protectedHeader: Uint8Array;
  payload: Uint8Array;
  signature: Uint8Array;
};

/** CBOR of `{1: -35}`: alg = ES384. Anything else is refused before any crypto runs. */
const PROTECTED_ES384 = Uint8Array.of(0xa1, 0x01, 0x38, 0x22);
/** CBOR tag 18 = COSE_Sign1; Nitro omits it, other producers prepend it. */
const TAG_COSE_SIGN1 = 0xd2;
const SIGNATURE_LEN = 96;
const SIGNATURE1_CONTEXT = 'Signature1';

function isTagByte(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0xc0 && byte <= 0xdb;
}

/**
 * Splits the envelope. Accepts the tag-18 wrapper and the bare array; any other tag,
 * trailing bytes or a shape that isn't `[bstr, map, bstr, bstr]` is `cose_malformed`.
 *
 * @throws VerifierError `cose_malformed` | `cose_wrong_alg` | `cose_bad_signature_length`
 */
export function decodeCoseSign1(bytes: Uint8Array): CoseSign1 {
  let body = bytes;
  if (body[0] === TAG_COSE_SIGN1) body = body.subarray(1);
  else if (isTagByte(body[0])) throw new VerifierError('cose_malformed', 'unexpected CBOR tag');
  let outer: unknown;
  try {
    outer = decode(body, { useMaps: true, strict: true, rejectDuplicateMapKeys: true });
  } catch {
    throw new VerifierError('cose_malformed', 'not a CBOR structure');
  }
  if (!Array.isArray(outer) || outer.length !== 4) {
    throw new VerifierError('cose_malformed', 'not a 4-element COSE_Sign1 array');
  }
  const [protectedHeader, unprotected, payload, signature] = outer as unknown[];
  if (
    !(protectedHeader instanceof Uint8Array) ||
    !(unprotected instanceof Map) ||
    !(payload instanceof Uint8Array) ||
    !(signature instanceof Uint8Array)
  ) {
    throw new VerifierError('cose_malformed', 'COSE_Sign1 elements have the wrong types');
  }
  if (!equalBytes(protectedHeader, PROTECTED_ES384)) {
    throw new VerifierError('cose_wrong_alg', 'protected header is not {alg: ES384}');
  }
  if (signature.length !== SIGNATURE_LEN) {
    throw new VerifierError(
      'cose_bad_signature_length',
      `signature is ${signature.length} bytes, expected ${SIGNATURE_LEN}`,
    );
  }
  return { protectedHeader, payload, signature };
}

/** RFC 9052 §4.4: `["Signature1", protected, external_aad = h'', payload]`, the bytes that were signed. */
export function sigStructure(cose: CoseSign1): Uint8Array {
  return encode([SIGNATURE1_CONTEXT, cose.protectedHeader, new Uint8Array(0), cose.payload]);
}

/**
 * ECDSA P-384 / SHA-384 over the Sig_structure with the leaf certificate's key
 * (97-byte uncompressed point). `lowS: false` because Nitro's signer doesn't
 * normalize `s` (archived document 1 is high-S), and malleability is irrelevant
 * here: a signature is evidence, never a replay key. Never throws: a malformed
 * key or signature is just "not verified".
 */
export function verifyEs384(publicKeyPoint: Uint8Array, cose: CoseSign1): boolean {
  try {
    return p384.verify(cose.signature, sha384(sigStructure(cose)), publicKeyPoint, {
      lowS: false,
      prehash: false,
    });
  } catch {
    return false;
  }
}
