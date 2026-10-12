// The pinned Marlin blue v3.0.0 arm64 base-image PCRs must be what both archived documents carry.
import { toHex } from '@tio/encoding';
import { describe, expect, it } from 'vitest';
import { DOC_IDS, rawDocument } from '../test-fixtures.ts';
import { MARLIN_BLUE_V3_ARM64_PCRS } from './pinned.ts';

describe('MARLIN_BLUE_V3_ARM64_PCRS', () => {
  it('are_three_48_byte_values', () => {
    for (const pcr of [
      MARLIN_BLUE_V3_ARM64_PCRS.pcr0,
      MARLIN_BLUE_V3_ARM64_PCRS.pcr1,
      MARLIN_BLUE_V3_ARM64_PCRS.pcr2,
    ]) {
      expect(pcr).toHaveLength(48);
    }
  });

  it('are_not_the_all_zero_values_of_a_debug_enclave', () => {
    expect(toHex(MARLIN_BLUE_V3_ARM64_PCRS.pcr0)).not.toBe('00'.repeat(48));
  });

  it.each(DOC_IDS)('equal_pcr0_pcr1_pcr2_of_document_%i', (id) => {
    const { pcrs } = rawDocument(id);
    expect(toHex(MARLIN_BLUE_V3_ARM64_PCRS.pcr0)).toBe(toHex(pcrs.get(0) ?? new Uint8Array()));
    expect(toHex(MARLIN_BLUE_V3_ARM64_PCRS.pcr1)).toBe(toHex(pcrs.get(1) ?? new Uint8Array()));
    expect(toHex(MARLIN_BLUE_V3_ARM64_PCRS.pcr2)).toBe(toHex(pcrs.get(2) ?? new Uint8Array()));
  });
});
