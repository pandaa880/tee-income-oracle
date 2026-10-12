// Certificate parsing and the Nitro chain walk: pinned root -> 3 intermediates -> leaf.
//
// Spec choices recorded here:
// - Validity is checked at the document's own timestamp, so "expired" / "not yet valid" use a
//   fixed `atMs` (never Date.now()).
// - Patched-DER rows cannot re-sign the certificate, so each one is also a broken signature.
//   They assert the structural code (chain_not_ca, chain_pathlen, chain_key_usage,
//   chain_wrong_algorithm, chain_issuer_mismatch), which pins this order: per-certificate
//   structural checks and issuer-name matching happen BEFORE signature verification.
// - Only same-length patches; each patch asserts its pattern matched exactly as often as expected.
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex, utf8 } from '@tio/encoding';
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  DOC_IDS,
  ROOT_SHA256_HEX,
  TIMESTAMP_MS,
  expectBaselineSucceeds,
  expectThrown,
  patchBytes,
  thrownCode,
  rawDocument,
  serialNumberOf,
} from '../test-fixtures.ts';
import { AWS_NITRO_ROOT_DER, AWS_NITRO_ROOT_SHA256 } from './pinned.ts';
import { parseCertificate, verifyChain } from './x509.ts';

const doc0 = rawDocument(0);
const chainAt = (overrides: Partial<Parameters<typeof verifyChain>[0]> = {}) => ({
  leaf: doc0.certificate,
  cabundle: doc0.cabundle,
  pinnedRoot: AWS_NITRO_ROOT_DER,
  atMs: TIMESTAMP_MS[0],
  ...overrides,
});
const withBundle = (index: number, der: Uint8Array): Uint8Array[] =>
  doc0.cabundle.map((cert, i) => (i === index ? der : cert));
const bundleCert = (index: number): Uint8Array => doc0.cabundle[index] ?? new Uint8Array();

describe('pinned AWS Nitro root', () => {
  it('has_the_published_sha256', () => {
    expect(AWS_NITRO_ROOT_SHA256).toBe(ROOT_SHA256_HEX);
  });

  it('constant_der_hashes_to_the_published_sha256', () => {
    expect(toHex(sha256(AWS_NITRO_ROOT_DER))).toBe(ROOT_SHA256_HEX);
  });

  it.each(DOC_IDS)('equals_the_first_cabundle_entry_of_document_%i', (id) => {
    expect(toHex(rawDocument(id).cabundle[0] ?? new Uint8Array())).toBe(toHex(AWS_NITRO_ROOT_DER));
  });
});

describe('parseCertificate', () => {
  it('reads_the_leaf', () => {
    const leaf = parseCertificate(doc0.certificate);
    expect(leaf.isCa).toBe(false);
    expect(leaf.pathLen).toBeUndefined();
    expect(leaf.publicKey).toHaveLength(97);
    expect(leaf.publicKey[0]).toBe(0x04);
    expect(leaf.notBeforeMs).toBe(Date.UTC(2026, 9, 8, 13, 50, 25));
    expect(leaf.notAfterMs).toBe(Date.UTC(2026, 9, 8, 16, 50, 28));
    expect(leaf.signatureAlgorithm).toBe('1.2.840.10045.4.3.3');
    expect(leaf.keyUsage?.digitalSignature).toBe(true);
    expect(toHex(leaf.issuerDer)).toContain(
      toHex(utf8('i-0c67e83388ff13b48.ap-south-1.aws.nitro-enclaves')),
    );
    expect(toHex(leaf.der)).toBe(toHex(doc0.certificate));
  });

  it('reads_the_root_as_a_ca_without_path_length', () => {
    const root = parseCertificate(AWS_NITRO_ROOT_DER);
    expect(root.isCa).toBe(true);
    expect(root.pathLen).toBeUndefined();
    expect(toHex(root.subjectDer)).toBe(toHex(root.issuerDer));
    expect(toHex(root.subjectDer)).toContain(toHex(utf8('aws.nitro-enclaves')));
  });

  it('reads_path_lengths_2_1_0_down_the_intermediates', () => {
    const intermediates = doc0.cabundle.slice(1).map((der) => parseCertificate(der));
    expect(intermediates.map((c) => c.pathLen)).toEqual([2, 1, 0]);
    expect(intermediates.every((c) => c.isCa && c.keyUsage?.keyCertSign === true)).toBe(true);
  });

  it('rejects_bytes_that_are_not_a_certificate', () => {
    expectThrown(() => parseCertificate(new Uint8Array([1, 2, 3, 4])), 'cert_malformed');
  });

  it('rejects_a_truncated_certificate', () => {
    expectThrown(() => parseCertificate(doc0.certificate.subarray(0, 300)), 'cert_malformed');
  });
});

describe('verifyChain on the archived documents', () => {
  it.each(DOC_IDS)('accepts_document_%i_at_its_own_timestamp', (id) => {
    const raw = rawDocument(id);
    const leaf = verifyChain({
      leaf: raw.certificate,
      cabundle: raw.cabundle,
      pinnedRoot: AWS_NITRO_ROOT_DER,
      atMs: TIMESTAMP_MS[id],
    });
    expect(leaf.isCa).toBe(false);
    expect(toHex(leaf.der)).toBe(toHex(raw.certificate));
  });

  it('rejects_a_time_after_the_leaf_expired_as_chain_expired', () => {
    const leaf = parseCertificate(doc0.certificate);
    expectBaselineSucceeds(() => verifyChain(chainAt()));
    expectThrown(() => verifyChain(chainAt({ atMs: leaf.notAfterMs + 1000 })), 'chain_expired');
  });

  it('rejects_a_year_later_as_chain_expired', () => {
    expectThrown(
      () => verifyChain(chainAt({ atMs: TIMESTAMP_MS[0] + 365 * DAY_MS })),
      'chain_expired',
    );
  });

  it('rejects_a_time_before_the_leaf_was_issued_as_chain_not_yet_valid', () => {
    const leaf = parseCertificate(doc0.certificate);
    expectThrown(
      () => verifyChain(chainAt({ atMs: leaf.notBeforeMs - 1000 })),
      'chain_not_yet_valid',
    );
  });

  it('rejects_a_year_earlier_as_chain_not_yet_valid', () => {
    expectThrown(
      () => verifyChain(chainAt({ atMs: TIMESTAMP_MS[0] - 365 * DAY_MS })),
      'chain_not_yet_valid',
    );
  });
});

describe('verifyChain root pinning and shape', () => {
  it('rejects_another_certificate_as_the_pinned_root', () => {
    expectBaselineSucceeds(() => verifyChain(chainAt()));
    expectThrown(() => verifyChain(chainAt({ pinnedRoot: bundleCert(1) })), 'root_not_pinned');
  });

  it('rejects_a_pinned_root_with_one_flipped_byte', () => {
    const flipped = AWS_NITRO_ROOT_DER.slice();
    flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 1;
    expectThrown(() => verifyChain(chainAt({ pinnedRoot: flipped })), 'root_not_pinned');
  });

  it('rejects_a_reversed_cabundle', () => {
    expectThrown(
      () => verifyChain(chainAt({ cabundle: doc0.cabundle.toReversed() })),
      'root_not_pinned',
    );
  });

  it('rejects_a_leaf_in_the_cabundle_as_an_issuer', () => {
    expectBaselineSucceeds(() => verifyChain(chainAt()));
    const code = thrownCode(() =>
      verifyChain(chainAt({ cabundle: [...doc0.cabundle, doc0.certificate] })),
    );
    // The final link's issuer is the last intermediate, not the leaf; a non-CA issuer is also wrong.
    expect(['chain_issuer_mismatch', 'chain_not_ca']).toContain(code);
  });

  it('rejects_a_ca_certificate_as_the_leaf', () => {
    expectThrown(
      () => verifyChain(chainAt({ leaf: bundleCert(3), cabundle: doc0.cabundle.slice(0, 3) })),
      'chain_leaf_is_ca',
    );
  });
});

describe('verifyChain structural rules (same-length DER patches)', () => {
  it('rejects_an_intermediate_with_ca_false', () => {
    // BasicConstraints { cA TRUE, pathLen 1 } -> cA FALSE: 30 06 01 01 ff 02 01 01
    const patched = patchBytes(bundleCert(2), '30060101ff020101', 4, () => 0x00);
    expectBaselineSucceeds(() => verifyChain(chainAt()));
    expectThrown(() => verifyChain(chainAt({ cabundle: withBundle(2, patched) })), 'chain_not_ca');
  });

  it('rejects_a_path_length_constraint_exceeded_below_it', () => {
    // intermediate 2 (pathLen 1) -> pathLen 0, yet a CA intermediate still follows it
    const patched = patchBytes(bundleCert(2), '30060101ff020101', 7, () => 0x00);
    expectThrown(() => verifyChain(chainAt({ cabundle: withBundle(2, patched) })), 'chain_pathlen');
  });

  it('rejects_an_intermediate_without_key_cert_sign', () => {
    // KeyUsage 03 02 01 86 (digitalSignature, keyCertSign, cRLSign) -> 03 02 01 80 (digitalSignature)
    const patched = patchBytes(bundleCert(1), '551d0f0101ff0404030201', 11, () => 0x80);
    expectThrown(
      () => verifyChain(chainAt({ cabundle: withBundle(1, patched) })),
      'chain_key_usage',
    );
  });

  it('rejects_an_intermediate_signed_with_another_algorithm_oid', () => {
    // ecdsa-with-SHA384 (1.2.840.10045.4.3.3) -> ecdsa-with-SHA256 (...4.3.2), both occurrences
    const patched = patchBytes(bundleCert(1), '2a8648ce3d040303', 7, () => 0x02, 2);
    expectThrown(
      () => verifyChain(chainAt({ cabundle: withBundle(1, patched) })),
      'chain_wrong_algorithm',
    );
  });

  it('rejects_a_leaf_whose_issuer_name_differs_in_one_character', () => {
    // "...aws.nitro-enclaves" -> "...aws.Nitro-enclaves" in the leaf's issuer (same length)
    const patched = patchBytes(doc0.certificate, toHex(utf8('nitro-enclaves')), 0, () => 0x4e);
    expectBaselineSucceeds(() => verifyChain(chainAt()));
    expectThrown(() => verifyChain(chainAt({ leaf: patched })), 'chain_issuer_mismatch');
  });

  it('rejects_a_leaf_with_one_changed_tbs_byte_as_chain_signature_invalid', () => {
    // last byte of the serial number: nothing structural changes, only the signed bytes
    const serial = toHex(serialNumberOf(doc0.certificate));
    const patched = patchBytes(doc0.certificate, serial, serial.length / 2 - 1, (b) => b ^ 1);
    expectBaselineSucceeds(() => verifyChain(chainAt()));
    expectThrown(() => verifyChain(chainAt({ leaf: patched })), 'chain_signature_invalid');
  });

  it('rejects_an_intermediate_with_one_changed_tbs_byte_as_chain_signature_invalid', () => {
    const serial = toHex(serialNumberOf(bundleCert(3)));
    const patched = patchBytes(bundleCert(3), serial, serial.length / 2 - 1, (b) => b ^ 1);
    expectThrown(
      () => verifyChain(chainAt({ cabundle: withBundle(3, patched) })),
      'chain_signature_invalid',
    );
  });
});

describe('parseCertificate SPKI pinning (same-length DER patches, review round 1)', () => {
  // ecPublicKey OID 1.2.840.10045.2.1 -> ...2.2 (one occurrence in the leaf)
  it('rejects_a_public_key_algorithm_that_is_not_ec_public_key', () => {
    expectBaselineSucceeds(() => parseCertificate(doc0.certificate));
    const patched = patchBytes(doc0.certificate, '06072a8648ce3d0201', 8, () => 0x02);
    expectThrown(() => parseCertificate(patched), 'cert_malformed');
  });

  // secp384r1 1.3.132.0.34 -> 1.3.132.0.35
  it('rejects_a_curve_that_is_not_secp384r1', () => {
    const patched = patchBytes(doc0.certificate, '06052b81040022', 6, () => 0x23);
    expectThrown(() => parseCertificate(patched), 'cert_malformed');
  });

  // BIT STRING 03 62 00 04 ...: the 0x04 uncompressed-point prefix -> 0x03
  it('rejects_a_public_key_point_without_the_uncompressed_prefix', () => {
    const patched = patchBytes(doc0.certificate, '03620004', 3, () => 0x03);
    expectThrown(() => parseCertificate(patched), 'cert_malformed');
  });
});

describe('verifyChain: remaining structural rules (review round 1)', () => {
  it('rejects_a_leaf_without_digital_signature_key_usage', () => {
    // KeyUsage of the leaf: clear the digitalSignature bit (0x80 of the first content byte).
    const hex = toHex(doc0.certificate);
    const match = /551d0f(?:0101ff)?0404(0302[0-9a-f]{2})([0-9a-f]{2})/.exec(hex);
    expect(match).not.toBeNull();
    const needle = match?.[0] ?? '';
    const patched = patchBytes(doc0.certificate, needle, needle.length / 2 - 1, (b) => b & 0x7f);
    expectBaselineSucceeds(() => verifyChain(chainAt()));
    const failure = (() => {
      try {
        verifyChain(chainAt({ leaf: patched }));
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toMatchObject({ code: 'chain_key_usage' });
    expect((failure as Error).message).toContain('leaf');
  });

  it('rejects_a_time_before_the_root_was_issued_naming_the_root', () => {
    const failure = (() => {
      try {
        verifyChain(chainAt({ atMs: Date.UTC(2019, 0, 1) }));
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toMatchObject({ code: 'chain_not_yet_valid' });
    expect((failure as Error).message).toContain('root');
  });

  it('rejects_an_outer_signature_algorithm_that_differs_from_the_inner_one', () => {
    // The algorithm identifier appears twice: inside the TBS and after it (outer). Patch the outer only.
    const hex = toHex(bundleCert(1));
    const needle = '300a06082a8648ce3d040303';
    const first = hex.indexOf(needle);
    const second = hex.indexOf(needle, first + 1);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(second % 2).toBe(0);
    const bytes = bundleCert(1).slice();
    const at = second / 2 + needle.length / 2 - 1;
    bytes[at] = 0x02;
    expectBaselineSucceeds(() => verifyChain(chainAt()));
    expectThrown(
      () => verifyChain(chainAt({ cabundle: withBundle(1, bytes) })),
      'chain_wrong_algorithm',
    );
  });

  it('error_messages_name_certificates_by_position_not_by_dn_text', () => {
    const patched = patchBytes(doc0.certificate, toHex(utf8('nitro-enclaves')), 0, () => 0x4e);
    const failure = (() => {
      try {
        verifyChain(chainAt({ leaf: patched }));
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toMatchObject({ code: 'chain_issuer_mismatch' });
    const message = (failure as Error).message;
    expect(message).toContain('leaf');
    expect(message).not.toContain('Nitro-enclaves');
    expect(message).not.toContain('CN=');
  });
});

/**
 * The leaf with its TBS SEQUENCE length re-encoded in a non-minimal long form
 * (`30 82 LL LL` → `30 83 00 LL LL`) and the outer length bumped by one. The
 * bytes are a different (BER) encoding of the same TBS, so a verifier that
 * hashed `serialize(parse(tbs))` would still accept the signature; one that
 * hashes the bytes as they appear must reject it.
 */
function leafWithNonMinimalTbsLength(): Uint8Array {
  const der = doc0.certificate;
  expect(der[0]).toBe(0x30);
  expect(der[1]).toBe(0x82);
  expect(der[4]).toBe(0x30);
  expect(der[5]).toBe(0x82);
  const outerLen = ((der[2] ?? 0) << 8) | (der[3] ?? 0);
  const out = new Uint8Array(der.length + 1);
  out[0] = 0x30;
  out[1] = 0x82;
  out[2] = (outerLen + 1) >> 8;
  out[3] = (outerLen + 1) & 0xff;
  out[4] = 0x30;
  out[5] = 0x83;
  out[6] = 0x00;
  out.set(der.subarray(6), 7);
  return out;
}

describe('verifyChain signs the raw TBS bytes, not a re-encoding (review round 2)', () => {
  it('rejects_a_leaf_whose_tbs_length_is_encoded_non_minimally', () => {
    expectBaselineSucceeds(() => verifyChain(chainAt()));
    const code = thrownCode(() => verifyChain(chainAt({ leaf: leafWithNonMinimalTbsLength() })));
    // asn1js accepts the long form (then the raw bytes differ from what was signed) or rejects it
    // (then the certificate is malformed); a PASS is the only wrong answer.
    expect(['chain_signature_invalid', 'cert_malformed']).toContain(code);
  });
});
