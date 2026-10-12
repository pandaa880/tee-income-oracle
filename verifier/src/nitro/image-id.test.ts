// Oyster image id and PCR16 (docker-compose commitment) against the two archived documents.
import { toHex } from '@tio/encoding';
import { describe, expect, it } from 'vitest';
import {
  DOC_IDS,
  IMAGE_ID_HEX,
  expectBaselineSucceeds,
  expectThrown,
  loadCompose,
  rawDocument,
  referenceImageId,
} from '../test-fixtures.ts';
import { COMPOSE_INIT_PARAM_PATH, imageId, pcr16FromCompose } from './image-id.ts';

describe('COMPOSE_INIT_PARAM_PATH', () => {
  it('is_the_oyster_init_params_path', () => {
    expect(COMPOSE_INIT_PARAM_PATH).toBe('/init-params/docker-compose.yml');
  });
});

describe.each(DOC_IDS)('document %i', (id) => {
  const { pcrs } = rawDocument(id);

  it('has_the_known_image_id', () => {
    expect(toHex(imageId(pcrs))).toBe(IMAGE_ID_HEX);
  });

  it('matches_the_independent_formula', () => {
    expect(toHex(imageId(pcrs))).toBe(toHex(referenceImageId(pcrs)));
  });

  it('has_a_pcr16_equal_to_the_commitment_to_the_published_compose', () => {
    expect(toHex(pcr16FromCompose(loadCompose()))).toBe(toHex(pcrs.get(16) ?? new Uint8Array()));
  });

  it('changes_when_pcr0_is_zeroed', () => {
    expectBaselineSucceeds(() => imageId(pcrs));
    const zeroed = new Map(pcrs).set(0, new Uint8Array(48));
    expect(toHex(imageId(zeroed))).not.toBe(IMAGE_ID_HEX);
  });

  it.each([0, 1, 2, 16])('changes_when_pcr%i_changes_by_one_byte', (index) => {
    const changed = new Map(pcrs);
    const value = (pcrs.get(index) ?? new Uint8Array(48)).slice();
    value[0] = (value[0] ?? 0) ^ 1;
    changed.set(index, value);
    expect(toHex(imageId(changed))).not.toBe(IMAGE_ID_HEX);
  });

  it('ignores_pcrs_outside_0_1_2_16', () => {
    const changed = new Map(pcrs).set(5, new Uint8Array(48).fill(7));
    expect(toHex(imageId(changed))).toBe(IMAGE_ID_HEX);
  });

  it.each([0, 1, 2, 16])('rejects_a_missing_pcr%i', (index) => {
    const missing = new Map(pcrs);
    missing.delete(index);
    expectBaselineSucceeds(() => imageId(pcrs));
    expectThrown(() => imageId(missing), 'document_malformed');
  });

  it('rejects_a_pcr_of_47_bytes', () => {
    const short = new Map(pcrs).set(2, (pcrs.get(2) ?? new Uint8Array()).subarray(0, 47));
    expectThrown(() => imageId(short), 'document_malformed');
  });
});

describe('pcr16FromCompose', () => {
  it('is_48_bytes', () => {
    expect(pcr16FromCompose(loadCompose())).toHaveLength(48);
  });

  it('differs_when_one_compose_byte_changes', () => {
    const compose = loadCompose();
    const changed = compose.slice();
    changed[0] = (changed[0] ?? 0) ^ 1;
    expect(toHex(pcr16FromCompose(changed))).not.toBe(toHex(pcr16FromCompose(compose)));
  });

  it('differs_when_the_compose_gains_a_trailing_newline', () => {
    const compose = loadCompose();
    const longer = Uint8Array.from([...compose, 0x0a]);
    expect(toHex(pcr16FromCompose(longer))).not.toBe(toHex(pcr16FromCompose(compose)));
  });

  it('is_deterministic', () => {
    expect(toHex(pcr16FromCompose(loadCompose()))).toBe(toHex(pcr16FromCompose(loadCompose())));
  });
});
