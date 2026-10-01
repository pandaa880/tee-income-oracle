import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decrypt, DecryptError, deriveSessionKey } from '../crypto/cipher.ts';
import { sessionKeyPairFromScalar, type KeyMode } from '../crypto/ecdh.ts';
import { b64Decode, fromHex, pemToDer, toHex } from '../crypto/encoding.ts';
import { verifyCompact, verifyDetached } from '../crypto/jws.ts';
import { base58Decode, buildMessage, buildPayload } from '../attest/payload.ts';
import {
  NEGATIVE_CASES,
  scoredJson,
  buildCase,
  type CaseFiles,
  type CaseOptions,
  type ErrorCode,
  type NegativeId,
} from './cases.ts';
import { checkCase } from './check-case.ts';
import { loadTestKeys, pinned, type TestKeys } from './keys.ts';
import { buildPersonas, type Persona } from './personas.ts';

/** Slice 2e negatives (plan table): id and the code the enclave must report. */
const EVALUATE_NEGATIVES = [
  ['fetch_txnid_mismatch', 'session_mismatch'],
  ['consent_id_mismatch', 'session_mismatch'],
  ['consent_expired', 'consent_invalid'],
  ['consent_not_started', 'consent_invalid'],
  ['window_outside_consent', 'window_mismatch'],
  ['window_too_short', 'window_too_short'],
  ['window_stale', 'window_stale'],
  ['statement_outside_window', 'window_mismatch'],
  ['multi_fip_response', 'bad_fetch_response'],
  ['multi_account_response', 'bad_fetch_response'],
  ['fip_envelope_malformed', 'bad_fip_envelope'],
  ['amount_three_decimals', 'bad_fi_data'],
  ['amount_negative_string', 'bad_fi_data'],
  ['fi_xml', 'unsupported_fi_format'],
  ['order_txnid_before_decrypt', 'session_mismatch'],
  ['order_stale_before_decrypt', 'window_stale'],
] as const satisfies readonly (readonly [NegativeId, ErrorCode])[];

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
  ...EVALUATE_NEGATIVES.map(([id]) => id),
];

const EXPECTED_ERROR_CODES = {
  fetch_response_flipped: 'bad_aa_signature',
  ciphertext_flipped: 'decrypt_failed',
  fi_plaintext_changed: 'bad_fip_signature',
  consent_tampered: 'bad_consent_signature',
  consent_not_active: 'consent_invalid',
  unpinned_aa_key: 'unknown_kid',
  alg_none: 'bad_alg',
  alg_hs256: 'bad_alg',
  detached_no_crit: 'bad_header',
  ...Object.fromEntries(EVALUATE_NEGATIVES),
} as Record<NegativeId, ErrorCode>;

// The layer each negative case breaks (FORMATS §11): "inner" cases break a
// layer *inside* the AA detached signature over the fetch response, so that
// outer signature must still verify with the real AA key.
const INNER_LAYER_NEGATIVE_IDS: readonly NegativeId[] = [
  'ciphertext_flipped',
  'fi_plaintext_changed',
  'consent_not_active',
  // Every slice 2e negative breaks a layer behind the AA signature.
  ...EVALUATE_NEGATIVES.map(([id]) => id),
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
  it('covers exactly the 25 negative ids (9 original + 16 from slice 2e)', () => {
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

describe('scoredJson', () => {
  it('fails generation when the TS scorer disagrees with expected_tier', () => {
    const stressed = buildPersonas().find((p) => p.persona_id === 'stressed');
    if (stressed === undefined) {
      throw new Error('stressed persona missing');
    }
    const mislabelled: Persona = { ...stressed, expected_tier: 'A' };
    expect(() => scoredJson(mislabelled)).toThrow(/TS scorer gave REJECT, expected A/);
  });

  it('returns the tier when it matches expected_tier', () => {
    const steady = buildPersonas().find((p) => p.persona_id === 'salaried_steady');
    if (steady === undefined) {
      throw new Error('salaried_steady persona missing');
    }
    expect(scoredJson(steady).tier).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// Slice 2e: session.json / expected.json additions and per-layer shape of the
// new negatives. Everything is read back from the built files, so the tests
// state the contract (plan "Generator", FORMATS §11) independently of how
// cases.ts builds them.
// ---------------------------------------------------------------------------

const DAY = 86_400;
const ORACLE_PROGRAM_ID = 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8';

type Json = Record<string, unknown>;

function jsonFile(files: CaseFiles, name: string): Json {
  const bytes = required(files.get(name), `case is missing ${name}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as Json;
}

function textFile(files: CaseFiles, name: string): string {
  return new TextDecoder().decode(required(files.get(name), `case is missing ${name}`));
}

function unixOf(iso: unknown): number {
  return Date.parse(String(iso)) / 1000;
}

function sessionOf(files: CaseFiles) {
  const session = jsonFile(files, 'session.json');
  const range = session['fi_data_range'] as { from: string; to: string };
  return {
    raw: session,
    txnid: session['txnid'] as string,
    consentId: session['consent_id'] as string,
    now: session['now_unix'] as number,
    from: unixOf(range.from),
    to: unixOf(range.to),
  };
}

function consentOf(files: CaseFiles, keys: TestKeys) {
  const verified = verifyCompact(textFile(files, 'consent.jws'), [pinned(keys.aa)]);
  if (!verified.ok) {
    throw new Error(`consent.jws must verify with the AA key, got ${verified.code}`);
  }
  const consent = JSON.parse(new TextDecoder().decode(verified.value)) as Json;
  const range = consent['FIDataRange'] as { from: string; to: string };
  return {
    id: consent['consentId'] as string,
    status: consent['status'] as string,
    start: unixOf(consent['consentStart']),
    expiry: unixOf(consent['consentExpiry']),
    from: unixOf(range.from),
    to: unixOf(range.to),
  };
}

function fetchOf(files: CaseFiles) {
  return jsonFile(files, 'fetch_response.body') as {
    txnid: string;
    FI: { data: { encryptedFI: string }[]; KeyMaterial: Json }[];
  };
}

/** Decrypts `FI[0].data[0]` with the enclave key; throws DecryptError on a broken ciphertext. */
function decryptEnvelope(files: CaseFiles, keys: TestKeys): { fi: string; jws: string } {
  const session = jsonFile(files, 'session.json');
  const entry = required(fetchOf(files).FI[0], 'FI[0]');
  const material = entry.KeyMaterial as { Nonce: string; DHPublicKey: { KeyValue: string } };
  const enclave = sessionKeyPairFromScalar(session['mode'] as KeyMode, keys.enclaveScalar);
  const key = deriveSessionKey(
    enclave.sharedSecret(pemToDer(material.DHPublicKey.KeyValue)),
    b64Decode(session['enclave_nonce_b64'] as string),
    b64Decode(material.Nonce),
  );
  const encrypted = required(entry.data[0], 'FI[0].data[0]').encryptedFI;
  return JSON.parse(new TextDecoder().decode(decrypt(key, encrypted))) as {
    fi: string;
    jws: string;
  };
}

function fiText(files: CaseFiles, keys: TestKeys): string {
  return new TextDecoder().decode(b64Decode(decryptEnvelope(files, keys).fi));
}

function fipSignatureVerifies(files: CaseFiles, keys: TestKeys): boolean {
  const envelope = decryptEnvelope(files, keys);
  return verifyDetached(envelope.jws, b64Decode(envelope.fi), [pinned(keys.fip)]).ok;
}

describe('slice 2e: ids and codes', () => {
  it.each(EVALUATE_NEGATIVES)('%s maps to %s', (id, code) => {
    expect(NEGATIVE_CASES.find((c) => c.id === id)?.errorCode).toBe(code);
  });
});

describe('slice 2e: session.json attest fields', () => {
  const keys = loadKeys();
  const persona = salariedSteady();
  const files = buildCase('salaried_steady', persona, keys, { mode: 'wei25519', aaAlg: 'RS256' });
  const session = jsonFile(files, 'session.json');
  const attest = session['attest'] as Json;

  it('carries the consent id the consent JWS names', () => {
    expect(session['consent_id']).toBe(consentOf(files, keys).id);
  });

  it('carries a base58 wallet that decodes to 32 bytes', () => {
    expect(base58Decode(session['wallet'] as string)).toHaveLength(32);
  });

  it('carries the Anchor.toml oracle program id', () => {
    expect(attest['oracle_program_id']).toBe(ORACLE_PROGRAM_ID);
  });

  it('carries 32-byte base58 sas_credential and sas_schema, distinct from each other', () => {
    const credential = attest['sas_credential'] as string;
    const schema = attest['sas_schema'] as string;
    expect(base58Decode(credential)).toHaveLength(32);
    expect(base58Decode(schema)).toHaveLength(32);
    expect(credential).not.toBe(schema);
  });

  it('uses proof_type 1, measurement_id 0 and expiry_unix = now_unix + 600', () => {
    expect(attest['proof_type']).toBe(1);
    expect(attest['measurement_id']).toBe(0);
    expect(attest['expiry_unix']).toBe((session['now_unix'] as number) + 600);
  });

  it('keeps every earlier session.json member', () => {
    for (const member of [
      'case_id',
      'persona_id',
      'mode',
      'aa_alg',
      'enclave_key',
      'enclave_nonce_b64',
      'session_id',
      'txnid',
      'now_unix',
      'key_expiry_unix',
      'fi_data_range',
    ]) {
      expect(session).toHaveProperty(member);
    }
  });

  it('derives the wallet from the case id (different case, different wallet)', () => {
    const other = buildCase('trader_lumpy', persona, keys, { mode: 'wei25519', aaAlg: 'RS256' });
    expect(jsonFile(other, 'session.json')['wallet']).not.toBe(session['wallet']);
  });
});

describe('slice 2e: positive expected.json payload_hex / msg_hex', () => {
  const keys = loadKeys();
  const opts: CaseOptions = { mode: 'wei25519', aaAlg: 'RS256' };

  it('salaried_steady: payload_hex and msg_hex are the §7 / §8 bytes built from its own fields', () => {
    const files = buildCase('salaried_steady', salariedSteady(), keys, opts);
    const expected = jsonFile(files, 'expected.json');
    const session = sessionOf(files);
    const attest = session.raw['attest'] as Json;

    const payload = buildPayload({
      tier: 'A',
      proofType: 1,
      measurementId: 0,
      policyHash: fromHex(expected['policy_hash'] as string),
      consentHash: fromHex(expected['consent_hash'] as string),
      issuedAt: BigInt(session.now),
      windowFrom: expected['window_from'] as number,
      windowTo: expected['window_to'] as number,
    });
    expect(expected['payload_hex']).toBe(toHex(payload));
    expect(toHex(payload)).toHaveLength(166);

    const message = buildMessage(
      {
        oracleProgramId: base58Decode(attest['oracle_program_id'] as string),
        sasCredential: base58Decode(attest['sas_credential'] as string),
        sasSchema: base58Decode(attest['sas_schema'] as string),
      },
      base58Decode(session.raw['wallet'] as string),
      payload,
      BigInt(attest['expiry_unix'] as number),
    );
    expect(expected['msg_hex']).toBe(toHex(message));
    expect(toHex(message)).toHaveLength(464);
  });

  it('stressed (REJECT): payload_hex and msg_hex are null', () => {
    const stressed = required(
      buildPersonas().find((p) => p.persona_id === 'stressed'),
      'stressed persona',
    );
    const expected = jsonFile(buildCase('stressed', stressed, keys, opts), 'expected.json');
    expect(expected['tier']).toBe('REJECT');
    expect(expected).toHaveProperty('payload_hex', null);
    expect(expected).toHaveProperty('msg_hex', null);
  });

  it('keeps tier, features, hashes and windows in expected.json', () => {
    const expected = jsonFile(
      buildCase('salaried_steady', salariedSteady(), keys, opts),
      'expected.json',
    );
    for (const member of [
      'policy_hash',
      'consent_hash',
      'window_from',
      'window_to',
      'tier',
      'features',
    ]) {
      expect(expected).toHaveProperty(member);
    }
  });
});

describe('slice 2e negatives: only the intended layer is broken', () => {
  const keys = loadKeys();
  const persona = salariedSteady();
  const build = (id: NegativeId): CaseFiles =>
    buildCase(id, persona, keys, { mode: 'wei25519', aaAlg: 'RS256', negative: id });

  it('fetch_txnid_mismatch: AA-signed fetch response names another txnid; consent id matches', () => {
    const files = build('fetch_txnid_mismatch');
    const session = sessionOf(files);
    expect(fetchOf(files).txnid).not.toBe(session.txnid);
    expect(consentOf(files, keys).id).toBe(session.consentId);
  });

  it('consent_id_mismatch: validly signed consent names another id; txnid matches', () => {
    const files = build('consent_id_mismatch');
    const session = sessionOf(files);
    expect(consentOf(files, keys).id).not.toBe(session.consentId);
    expect(fetchOf(files).txnid).toBe(session.txnid);
  });

  it('consent_expired: ACTIVE, expiry at or before now, start before now', () => {
    const files = build('consent_expired');
    const consent = consentOf(files, keys);
    const { now } = sessionOf(files);
    expect(consent.status).toBe('ACTIVE');
    expect(consent.expiry).toBeLessThanOrEqual(now);
    expect(consent.start).toBeLessThanOrEqual(now);
  });

  it('consent_not_started: ACTIVE, start after now, expiry after start', () => {
    const files = build('consent_not_started');
    const consent = consentOf(files, keys);
    const { now } = sessionOf(files);
    expect(consent.status).toBe('ACTIVE');
    expect(consent.start).toBeGreaterThan(now);
    expect(consent.expiry).toBeGreaterThan(consent.start);
  });

  it('window_outside_consent: consent range 30 days shorter than the request, not covering it', () => {
    const files = build('window_outside_consent');
    const consent = consentOf(files, keys);
    const session = sessionOf(files);
    expect(session.to - session.from - (consent.to - consent.from)).toBe(30 * DAY);
    expect(consent.from <= session.from && consent.to >= session.to).toBe(false);
    // Everything else is fine: consent active at now, request long and fresh.
    expect(consent.status).toBe('ACTIVE');
    expect(consent.start).toBeLessThanOrEqual(session.now);
    expect(consent.expiry).toBeGreaterThan(session.now);
    expect(session.now - session.to).toBeLessThanOrEqual(7 * DAY);
  });

  it('window_too_short: request and consent range are both 179 days', () => {
    const files = build('window_too_short');
    const consent = consentOf(files, keys);
    const session = sessionOf(files);
    expect(session.to - session.from).toBe(179 * DAY);
    expect(consent.to - consent.from).toBe(179 * DAY);
    expect(consent.from <= session.from && consent.to >= session.to).toBe(true);
  });

  it('window_stale: request ends more than 7 and at most 9 days before now, length >= 180 days', () => {
    const files = build('window_stale');
    const consent = consentOf(files, keys);
    const session = sessionOf(files);
    expect(session.now - session.to).toBeGreaterThan(7 * DAY);
    expect(session.now - session.to).toBeLessThanOrEqual(9 * DAY);
    expect(session.to - session.from).toBeGreaterThanOrEqual(180 * DAY);
    expect(consent.from <= session.from && consent.to >= session.to).toBe(true);
    expect(consent.expiry).toBeGreaterThan(session.now);
  });

  it('statement_outside_window: FIP-signed FI starts one day before the request', () => {
    const files = build('statement_outside_window');
    const session = sessionOf(files);
    expect(fipSignatureVerifies(files, keys)).toBe(true);
    const match = /"startDate":"(\d{4}-\d{2}-\d{2})/.exec(fiText(files, keys));
    const startDate = required(match?.[1], 'FI has a startDate');
    const fromDay = new Date(session.from * 1000).toISOString().slice(0, 10);
    const dayBefore = new Date((session.from - DAY) * 1000).toISOString().slice(0, 10);
    expect(startDate).toBe(dayBefore);
    expect(startDate).not.toBe(fromDay);
  });

  it('multi_fip_response: two FI[] entries, AA-signed', () => {
    expect(fetchOf(build('multi_fip_response')).FI).toHaveLength(2);
  });

  it('multi_account_response: one FI[] entry with two data[] items', () => {
    const fi = fetchOf(build('multi_account_response')).FI;
    expect(fi).toHaveLength(1);
    expect(fi[0]?.data).toHaveLength(2);
  });

  it('single-account positive responses keep exactly one FI entry with one data item', () => {
    const files = buildCase('salaried_steady', persona, keys, {
      mode: 'wei25519',
      aaAlg: 'RS256',
    });
    const fi = fetchOf(files).FI;
    expect(fi).toHaveLength(1);
    expect(fi[0]?.data).toHaveLength(1);
  });

  it('fip_envelope_malformed: decrypts, but envelope fi is not base64', () => {
    const envelope = decryptEnvelope(build('fip_envelope_malformed'), keys);
    expect(typeof envelope.jws).toBe('string');
    expect(/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.fi) && envelope.fi.length % 4 === 0).toBe(false);
  });

  it('amount_three_decimals: FIP-signed FI contains the amount 1234.567', () => {
    const files = build('amount_three_decimals');
    expect(fipSignatureVerifies(files, keys)).toBe(true);
    expect(fiText(files, keys)).toContain('1234.567');
  });

  it('amount_negative_string: FIP-signed FI contains the string amount "-0.50"', () => {
    const files = build('amount_negative_string');
    expect(fipSignatureVerifies(files, keys)).toBe(true);
    expect(fiText(files, keys)).toContain('"-0.50"');
  });

  it('fi_xml: FIP-signed FI bytes are XML', () => {
    const files = build('fi_xml');
    expect(fipSignatureVerifies(files, keys)).toBe(true);
    expect(fiText(files, keys).trimStart().startsWith('<')).toBe(true);
  });

  it('order_txnid_before_decrypt: txnid mismatch AND a ciphertext that does not decrypt', () => {
    const files = build('order_txnid_before_decrypt');
    expect(fetchOf(files).txnid).not.toBe(sessionOf(files).txnid);
    expect(() => decryptEnvelope(files, keys)).toThrow(DecryptError);
  });

  it('order_stale_before_decrypt: stale request AND a ciphertext that does not decrypt', () => {
    const files = build('order_stale_before_decrypt');
    const session = sessionOf(files);
    expect(session.now - session.to).toBeGreaterThan(7 * DAY);
    expect(() => decryptEnvelope(files, keys)).toThrow(DecryptError);
  });

  it('order_* cases use the same window facts as their single-layer twins', () => {
    const staleTwin = sessionOf(build('window_stale'));
    const staleOrder = sessionOf(build('order_stale_before_decrypt'));
    expect(staleOrder.now - staleOrder.to).toBe(staleTwin.now - staleTwin.to);
  });
});
