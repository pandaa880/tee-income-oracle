// The attestation document (CBOR map inside the COSE payload): field table for both archived
// devnet documents and the malformed-input rows. user_data is present but empty (0 bytes), nonce is null.
import { toHex } from '@tio/encoding';
import { encode } from 'cborg';
import { describe, expect, it } from 'vitest';
import {
  DOC_IDS,
  TIMESTAMP_MS,
  expectBaselineSucceeds,
  expectThrown,
  rawDocument,
} from '../test-fixtures.ts';
import { decodeAttestationDocument, parseAttestation } from './document.ts';

describe.each(DOC_IDS)('document %i', (id) => {
  const raw = rawDocument(id);
  const document = decodeAttestationDocument(raw.cose.payload);

  it('reads_the_timestamp_in_milliseconds', () => {
    expect(document.timestampMs).toBe(TIMESTAMP_MS[id]);
  });

  it('reads_module_id_and_the_sha384_digest', () => {
    expect(document.moduleId.length).toBeGreaterThan(0);
    expect(document.digest).toBe('SHA384');
  });

  it('reads_17_pcrs_of_48_bytes', () => {
    expect([...document.pcrs.keys()]).toEqual(Array.from({ length: 17 }, (_, i) => i));
    for (const value of document.pcrs.values()) {
      expect(value).toHaveLength(48);
    }
  });

  it('reads_the_pcr_values_unchanged', () => {
    expect(toHex(document.pcrs.get(16) ?? new Uint8Array())).toBe(
      toHex(raw.pcrs.get(16) ?? new Uint8Array()),
    );
  });

  it('reads_the_leaf_certificate_and_a_four_certificate_bundle', () => {
    expect(toHex(document.certificate)).toBe(toHex(raw.certificate));
    expect(document.cabundle).toHaveLength(4);
    expect(document.cabundle.map(toHex)).toEqual(raw.cabundle.map(toHex));
  });

  it('reads_the_64_byte_public_key', () => {
    expect(document.publicKey).toHaveLength(64);
    expect(toHex(document.publicKey ?? new Uint8Array())).toBe(toHex(raw.publicKey));
  });

  it('reads_user_data_as_present_and_empty_and_nonce_as_null', () => {
    expect(document.userData).toHaveLength(0);
    expect(document.nonce).toBeNull();
  });

  it('parseAttestation_returns_the_cose_and_the_same_document', () => {
    const parsed = parseAttestation(raw.bytes);
    expect(parsed.cose.signature).toHaveLength(96);
    expect(parsed.document).toEqual(document);
  });
});

describe('malformed documents', () => {
  const raw = rawDocument(0);
  const reencode = (change: (fields: Map<string, unknown>) => void): Uint8Array => {
    const fields = new Map(raw.fields);
    change(fields);
    return encode(fields);
  };

  it('accepts_the_map_re_encoded_unchanged_as_a_baseline', () => {
    expectBaselineSucceeds(() => decodeAttestationDocument(reencode(() => undefined)));
  });

  it('rejects_a_duplicate_map_key', () => {
    const payload = raw.cose.payload;
    expect(payload[0]).toBe(0xbf); // indefinite-length map
    expect(payload.at(-1)).toBe(0xff);
    expectBaselineSucceeds(() => decodeAttestationDocument(payload));
    // "digest": "SHA384" a second time, before the break byte
    const duplicate = [0x66, ...Buffer.from('digest'), 0x66, ...Buffer.from('SHA384')];
    const doubled = Uint8Array.from([...payload.subarray(0, -1), ...duplicate, 0xff]);
    expectThrown(() => decodeAttestationDocument(doubled), 'document_malformed');
  });

  it('rejects_a_missing_pcrs_field', () => {
    expectThrown(
      () => decodeAttestationDocument(reencode((f) => f.delete('pcrs'))),
      'document_malformed',
    );
  });

  it('rejects_a_timestamp_that_is_text', () => {
    expectThrown(
      () => decodeAttestationDocument(reencode((f) => f.set('timestamp', '1791467660480'))),
      'document_malformed',
    );
  });

  it('rejects_a_missing_certificate', () => {
    expectThrown(
      () => decodeAttestationDocument(reencode((f) => f.delete('certificate'))),
      'document_malformed',
    );
  });

  it('rejects_a_payload_that_is_not_a_map', () => {
    expectThrown(() => decodeAttestationDocument(encode([1, 2, 3])), 'document_malformed');
  });

  it('rejects_bytes_that_are_not_cbor', () => {
    expectThrown(
      () => decodeAttestationDocument(Uint8Array.from([0xff, 0xff])),
      'document_malformed',
    );
  });
});
