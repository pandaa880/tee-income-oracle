import { describe, expect, it } from 'vitest';
import { isPlaceholderCompose, parseImageId, parseVerifyOutput } from './oyster.ts';
import {
  PLACEHOLDER_COMPOSE,
  composeWithDigest,
  computeImageIdOutput,
  logLine,
  toHex,
  verifyOutput,
} from './testing/oyster-fake.ts';

const IMAGE_ID = 'ab'.repeat(32);
const OTHER_IMAGE_ID = 'cd'.repeat(32);
const PUB64 = '12'.repeat(64);
const PUB65 = '04' + PUB64;

describe('parseImageId', () => {
  it('reads_the_image_id_line', () => {
    expect(toHex(parseImageId(computeImageIdOutput(IMAGE_ID)))).toBe(IMAGE_ID);
  });

  it('returns_32_bytes', () => {
    expect(parseImageId(computeImageIdOutput(IMAGE_ID))).toHaveLength(32);
  });

  it('strips_ansi_colour_codes', () => {
    expect(toHex(parseImageId(computeImageIdOutput(IMAGE_ID, true)))).toBe(IMAGE_ID);
  });

  it('accepts_the_same_value_printed_twice', () => {
    const output = `${computeImageIdOutput(IMAGE_ID)}\n${computeImageIdOutput(IMAGE_ID)}`;
    expect(toHex(parseImageId(output))).toBe(IMAGE_ID);
  });

  it('throws_when_the_line_is_missing', () => {
    expect(() => parseImageId(logLine('compute_image_id', 'nothing here'))).toThrow(
      /expected one "Image ID" line, found 0/,
    );
    expect(() => parseImageId('')).toThrow(/expected one "Image ID" line, found 0/);
  });

  it.each([
    ['too_short', 'ab'.repeat(31)],
    ['too_long', 'ab'.repeat(33)],
    ['odd_length', 'a'.repeat(63)],
    ['not_hex', 'zz'.repeat(32)],
  ])('throws_on_%s', (_name, value) => {
    expect(() => parseImageId(computeImageIdOutput(value))).toThrow(
      /"Image ID" is not 32 bytes of lowercase hex/,
    );
  });

  it('throws_on_different_values', () => {
    const output = `${computeImageIdOutput(IMAGE_ID)}\n${computeImageIdOutput(OTHER_IMAGE_ID)}`;
    expect(() => parseImageId(output)).toThrow(/found 2 distinct values/);
  });
});

const good = (overrides: Partial<Parameters<typeof verifyOutput>[0]> = {}) =>
  verifyOutput({ enclavePublicKeyHex: PUB64, imageIdHex: IMAGE_ID, ...overrides });

describe('parseVerifyOutput', () => {
  it('reads_a_64_byte_public_key_and_the_image_id', () => {
    const parsed = parseVerifyOutput(good());
    expect(toHex(parsed.enclavePublicKey)).toBe(PUB64);
    expect(toHex(parsed.imageId)).toBe(IMAGE_ID);
  });

  it('reads_a_65_byte_public_key', () => {
    expect(toHex(parseVerifyOutput(good({ enclavePublicKeyHex: PUB65 })).enclavePublicKey)).toBe(
      PUB65,
    );
  });

  it('strips_ansi_colour_codes', () => {
    const parsed = parseVerifyOutput(good({ colour: true }));
    expect(toHex(parsed.enclavePublicKey)).toBe(PUB64);
    expect(toHex(parsed.imageId)).toBe(IMAGE_ID);
  });

  it('fails_closed_without_the_success_line', () => {
    expect(() => parseVerifyOutput(good({ omitSuccess: true }))).toThrow(/did not report success/);
  });

  it('fails_closed_without_the_public_key_line', () => {
    expect(() => parseVerifyOutput(good({ omitPublicKey: true }))).toThrow(
      /expected one "Enclave public key" line, found 0/,
    );
  });

  it('fails_closed_without_the_image_id_line', () => {
    expect(() => parseVerifyOutput(good({ omitImageId: true }))).toThrow(
      /expected one "Image id" line, found 0/,
    );
  });

  it.each([
    ['not_hex', 'zz'.repeat(64)],
    ['wrong_length_63', '12'.repeat(63)],
    ['wrong_length_66', '12'.repeat(66)],
    ['odd_length', '1'.repeat(127)],
  ])('fails_closed_on_public_key_%s', (_name, value) => {
    expect(() => parseVerifyOutput(good({ enclavePublicKeyHex: value }))).toThrow(
      /"Enclave public key" is not 64 or 65 bytes/,
    );
  });

  it.each([
    ['not_hex', 'zz'.repeat(32)],
    ['wrong_length', 'ab'.repeat(31)],
  ])('fails_closed_on_image_id_%s', (_name, value) => {
    expect(() => parseVerifyOutput(good({ imageIdHex: value }))).toThrow(
      /"Image id" is not 32 bytes/,
    );
  });

  it('fails_closed_when_an_error_level_line_is_present_even_with_a_success_line', () => {
    const extra = logLine('verify', 'attestation chain invalid', 'ERROR');
    expect(() => parseVerifyOutput(good({ extraLines: [extra] }))).toThrow(/logged an ERROR/);
  });

  it('fails_closed_on_an_error_line_in_colour', () => {
    const extra = logLine('verify', 'boom', 'ERROR', true);
    expect(() => parseVerifyOutput(good({ extraLines: [extra] }))).toThrow(/logged an ERROR/);
  });

  it('fails_closed_on_empty_output', () => {
    expect(() => parseVerifyOutput('')).toThrow(/did not report success/);
  });

  it('does_not_trust_a_success_line_without_the_key_lines', () => {
    expect(() => parseVerifyOutput(logLine('verify', 'Verification successful ✓'))).toThrow(
      /expected one "Enclave public key" line, found 0/,
    );
  });
});

describe('isPlaceholderCompose', () => {
  it('is_true_for_the_committed_template', () => {
    expect(isPlaceholderCompose(PLACEHOLDER_COMPOSE)).toBe(true);
  });

  it('is_true_for_REPLACE_ME_with_a_real_looking_digest', () => {
    const text = composeWithDigest('ab'.repeat(32)).replace(
      'docker.io/tio',
      'docker.io/REPLACE_ME',
    );
    expect(isPlaceholderCompose(text)).toBe(true);
  });

  it('is_true_for_an_all_zero_digest_without_REPLACE_ME', () => {
    expect(isPlaceholderCompose(composeWithDigest('0'.repeat(64)))).toBe(true);
  });

  it('is_false_for_a_pinned_non_zero_digest', () => {
    expect(isPlaceholderCompose(composeWithDigest('ab'.repeat(32)))).toBe(false);
  });

  it('is_false_for_a_digest_that_only_starts_with_zeros', () => {
    expect(isPlaceholderCompose(composeWithDigest('0'.repeat(63) + '1'))).toBe(false);
  });
});
