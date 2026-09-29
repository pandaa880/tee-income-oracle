import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyDetached } from '../crypto/jws.ts';
import {
  NEGATIVE_CASES,
  buildCase,
  type CaseFiles,
  type CaseOptions,
  type ErrorCode,
  type NegativeId,
} from './cases.ts';
import { checkCase } from './check-case.ts';
import { loadTestKeys, pinned, type TestKeys } from './keys.ts';
import { buildPersonas, type Persona } from './personas.ts';

const EXPECTED_NEGATIVE_IDS: readonly NegativeId[] = [
  'fetch_response_flipped',
  'ciphertext_flipped',
  'fi_plaintext_changed',
  'consent_tampered',
  'consent_not_active',
  'unpinned_aa_key',
  'alg_none',
  'alg_hs256',
  'detached_no_crit',
];

const EXPECTED_ERROR_CODES: Record<NegativeId, ErrorCode> = {
  fetch_response_flipped: 'bad_aa_signature',
  ciphertext_flipped: 'decrypt_failed',
  fi_plaintext_changed: 'bad_fip_signature',
  consent_tampered: 'bad_consent_signature',
  consent_not_active: 'consent_invalid',
  unpinned_aa_key: 'unknown_kid',
  alg_none: 'bad_alg',
  alg_hs256: 'bad_alg',
  detached_no_crit: 'bad_header',
};

// The layer each negative case breaks (FORMATS §11): "inner" cases break a
// layer *inside* the AA detached signature over the fetch response, so that
// outer signature must still verify with the real AA key.
const INNER_LAYER_NEGATIVE_IDS: readonly NegativeId[] = [
  'ciphertext_flipped',
  'fi_plaintext_changed',
  'consent_not_active',
];

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function keysDir(): string {
  return fileURLToPath(new URL('../../../test-vectors/keys/', import.meta.url));
}

function loadKeys(): TestKeys {
  return loadTestKeys(keysDir());
}

function salariedSteady(): Persona {
  return required(
    buildPersonas().find((p) => p.persona_id === 'salaried_steady'),
    'expected the salaried_steady persona',
  );
}

describe('NEGATIVE_CASES', () => {
  it('covers exactly the 9 negative ids in api.md', () => {
    expect(NEGATIVE_CASES.map((c) => c.id).toSorted()).toEqual(
      [...EXPECTED_NEGATIVE_IDS].toSorted(),
    );
  });

  it.each(NEGATIVE_CASES)('$id maps to the FORMATS §11 error code', (entry) => {
    expect(entry.errorCode).toBe(EXPECTED_ERROR_CODES[entry.id]);
  });
});

describe('buildCase: positive combinations', () => {
  const keys = loadKeys();
  const persona = salariedSteady();

  const combinations: readonly CaseOptions[] = [
    { mode: 'wei25519', aaAlg: 'RS256' },
    { mode: 'x25519', aaAlg: 'RS256' },
    { mode: 'wei25519', aaAlg: 'RS512' },
  ];

  it.each(combinations)(
    'mode=$mode aaAlg=$aaAlg: checkCase decrypts back to the persona fi',
    (opts) => {
      const files = buildCase('positive-combo', persona, keys, opts);
      const result = checkCase(files, keys);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('expected checkCase to succeed');
      }
      const decrypted: unknown = JSON.parse(new TextDecoder().decode(result.fi));
      expect(decrypted).toEqual(persona.fi);
    },
  );
});

describe('buildCase: negative cases', () => {
  const keys = loadKeys();
  const persona = salariedSteady();
  const baseOpts = { mode: 'wei25519', aaAlg: 'RS256' } as const;

  it.each(NEGATIVE_CASES)('$id fails with exactly its declared error code', (entry) => {
    const files = buildCase(entry.id, persona, keys, { ...baseOpts, negative: entry.id });
    const result = checkCase(files, keys);

    expect(result).toEqual({ ok: false, code: entry.errorCode });
  });

  it.each(INNER_LAYER_NEGATIVE_IDS)(
    '%s breaks an inner layer: the AA detached signature over fetch_response still verifies',
    (id) => {
      const files: CaseFiles = buildCase(id, persona, keys, { ...baseOpts, negative: id });
      const body = required(files.get('fetch_response.body'), 'expected fetch_response.body');
      const jwsBytes = required(files.get('fetch_response.jws'), 'expected fetch_response.jws');
      const jws = new TextDecoder().decode(jwsBytes);

      const outerResult = verifyDetached(jws, body, [pinned(keys.aa)]);
      expect(outerResult.ok).toBe(true);
    },
  );
});

describe('buildCase determinism', () => {
  it('produces byte-identical files for the same inputs', () => {
    const keys = loadKeys();
    const persona = salariedSteady();
    const opts: CaseOptions = { mode: 'wei25519', aaAlg: 'RS256' };

    const first = buildCase('determinism-check', persona, keys, opts);
    const second = buildCase('determinism-check', persona, keys, opts);

    expect([...first.keys()].toSorted()).toEqual([...second.keys()].toSorted());
    for (const [name, bytes] of first) {
      expect(second.get(name)).toEqual(bytes);
    }
  });
});
