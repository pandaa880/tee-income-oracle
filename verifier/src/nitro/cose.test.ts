// COSE_Sign1 (RFC 9052) decoding and ES384 verification against the two archived devnet documents.
// Spec choices: a protected header other than exactly `a1013822` (alg -35) is `cose_wrong_alg`,
// including a one-byte flip of it, so "flip the protected header" is asserted at decode time.
import { p384 } from '@noble/curves/nist.js';
import { toHex } from '@tio/encoding';
import { describe, expect, it } from 'vitest';
import {
  type CoseParts,
  DOC_IDS,
  certificatePoint,
  expectBaselineSucceeds,
  expectThrown,
  flipByteAt,
  joinCose,
  loadDocument,
  rawDocument,
  splitCose,
} from '../test-fixtures.ts';
import { decodeCoseSign1, sigStructure, verifyEs384 } from './cose.ts';

const withParts = (id: 0 | 1, change: (parts: CoseParts) => Partial<CoseParts>): Uint8Array => {
  const parts = splitCose(loadDocument(id));
  return joinCose({ ...parts, ...change(parts) });
};

describe.each(DOC_IDS)('document %i', (id) => {
  const raw = rawDocument(id);
  const point = certificatePoint(raw.certificate);

  it('decodes_into_protected_header_payload_and_96_byte_signature', () => {
    const cose = decodeCoseSign1(raw.bytes);
    expect(toHex(cose.protectedHeader)).toBe('a1013822');
    expect(toHex(cose.payload)).toBe(toHex(raw.cose.payload));
    expect(cose.signature).toHaveLength(96);
  });

  it('verifies_with_the_leaf_certificate_key', () => {
    expect(verifyEs384(point, decodeCoseSign1(raw.bytes))).toBe(true);
  });

  it('keeps_the_payload_exactly_as_signed_never_re_encoded', () => {
    const structure = sigStructure(decodeCoseSign1(raw.bytes));
    expect(toHex(structure)).toContain(toHex(raw.cose.payload));
  });

  it('rejects_a_flipped_signature_byte', () => {
    expect(verifyEs384(point, decodeCoseSign1(raw.bytes))).toBe(true);
    const tampered = withParts(id, (p) => ({ signature: flipByteAt(p.signature, 10) }));
    expect(verifyEs384(point, decodeCoseSign1(tampered))).toBe(false);
  });

  it('rejects_a_flipped_payload_byte', () => {
    expect(verifyEs384(point, decodeCoseSign1(raw.bytes))).toBe(true);
    const tampered = withParts(id, (p) => ({
      payload: flipByteAt(p.payload, Math.floor(p.payload.length / 2)),
    }));
    expect(verifyEs384(point, decodeCoseSign1(tampered))).toBe(false);
  });

  it('rejects_verification_with_another_certificates_key', () => {
    const other = certificatePoint(raw.cabundle[3] ?? new Uint8Array());
    expect(verifyEs384(other, decodeCoseSign1(raw.bytes))).toBe(false);
  });
});

describe('high-S signatures', () => {
  it('accepts_document_1_whose_signature_is_not_low_s', () => {
    const raw = rawDocument(1);
    const sig = raw.cose.signature;
    const s = BigInt(`0x${toHex(sig.subarray(48))}`);
    expect(s > p384.Point.Fn.ORDER / 2n).toBe(true);
    expect(verifyEs384(certificatePoint(raw.certificate), decodeCoseSign1(raw.bytes))).toBe(true);
  });
});

describe('decodeCoseSign1 framing', () => {
  const bytes = loadDocument(0);

  it('accepts_the_tag_18_wrapper', () => {
    const tagged = Uint8Array.from([0xd2, ...bytes]);
    expectBaselineSucceeds(() => decodeCoseSign1(bytes));
    expect(decodeCoseSign1(tagged)).toEqual(decodeCoseSign1(bytes));
  });

  it('rejects_any_other_tag', () => {
    expectBaselineSucceeds(() => decodeCoseSign1(bytes));
    expectThrown(() => decodeCoseSign1(Uint8Array.from([0xd8, 0x63, ...bytes])), 'cose_malformed');
  });

  it('rejects_bytes_cut_short', () => {
    expectThrown(() => decodeCoseSign1(bytes.subarray(0, 50)), 'cose_malformed');
  });

  it('rejects_empty_input', () => {
    expectThrown(() => decodeCoseSign1(new Uint8Array(0)), 'cose_malformed');
  });

  it('rejects_trailing_bytes_after_the_structure', () => {
    expectThrown(() => decodeCoseSign1(Uint8Array.from([...bytes, 0x00])), 'cose_malformed');
  });

  it('rejects_an_array_of_three_elements', () => {
    // 83 44 a1013822 a0 40: protected, unprotected, empty payload; no signature
    const three = Uint8Array.from([0x83, 0x44, 0xa1, 0x01, 0x38, 0x22, 0xa0, 0x40]);
    expectThrown(() => decodeCoseSign1(three), 'cose_malformed');
  });

  it('rejects_a_wrong_algorithm_header', () => {
    // alg -7 (ES256) instead of -35 (ES384); same structure otherwise
    const es256 = withParts(0, () => ({ protectedHeader: Uint8Array.from([0xa1, 0x01, 0x26]) }));
    expectBaselineSucceeds(() => decodeCoseSign1(bytes));
    expectThrown(() => decodeCoseSign1(es256), 'cose_wrong_alg');
  });

  it('rejects_a_flipped_protected_header_byte', () => {
    const flipped = withParts(0, (p) => ({ protectedHeader: flipByteAt(p.protectedHeader, 3) }));
    expectThrown(() => decodeCoseSign1(flipped), 'cose_wrong_alg');
  });

  it('rejects_a_95_byte_signature', () => {
    const short = withParts(0, (p) => ({ signature: p.signature.subarray(0, 95) }));
    expectThrown(() => decodeCoseSign1(short), 'cose_bad_signature_length');
  });

  it('rejects_a_97_byte_signature', () => {
    const long = withParts(0, (p) => ({ signature: Uint8Array.from([...p.signature, 0]) }));
    expectThrown(() => decodeCoseSign1(long), 'cose_bad_signature_length');
  });

  it('ignores_the_unprotected_header_contents', () => {
    const extra = withParts(0, () => ({ unprotected: new Map([[4, new Uint8Array([1])]]) }));
    expect(decodeCoseSign1(extra).signature).toHaveLength(96);
  });

  it('rebuilds_the_untouched_document_byte_for_byte', () => {
    expect(toHex(withParts(0, () => ({})))).toBe(toHex(bytes));
  });
});
