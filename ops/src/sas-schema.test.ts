import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_NAME,
  PAYLOAD_LEN,
  SAS_PROGRAM_ID,
  SAS_SO_PATH,
  SCHEMA_DESCRIPTION,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  payloadLength,
} from './sas-schema.ts';

// SAS SchemaDataType ids: U8=0, U32=2, U128=4, I64=8, String=12.
const SOURCE_MD = new URL('../../test-fixtures/sas/SOURCE.md', import.meta.url);

describe('sas-schema constants', () => {
  it('names the credential, schema and version', () => {
    expect(CREDENTIAL_NAME).toBe('tee-income-oracle');
    expect(SCHEMA_NAME).toBe('tio-income-tier');
    expect(SCHEMA_VERSION).toBe(1);
    expect(SCHEMA_DESCRIPTION.length).toBeGreaterThan(0);
  });

  it('uses the FORMATS section 7 layout', () => {
    expect([...SCHEMA_LAYOUT]).toEqual([0, 0, 0, 4, 4, 4, 4, 8, 2, 2]);
  });

  it('uses the FORMATS section 7 field names in order', () => {
    expect([...SCHEMA_FIELD_NAMES]).toEqual([
      'tier',
      'proof_type',
      'measurement_id',
      'policy_hash_lo',
      'policy_hash_hi',
      'consent_hash_lo',
      'consent_hash_hi',
      'issued_at',
      'window_from',
      'window_to',
    ]);
  });

  it('has one field name per layout entry', () => {
    expect(SCHEMA_FIELD_NAMES.length).toBe(SCHEMA_LAYOUT.length);
  });

  it('keeps PDA seed names within 32 UTF-8 bytes', () => {
    expect(Buffer.byteLength(CREDENTIAL_NAME, 'utf8')).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(SCHEMA_NAME, 'utf8')).toBeLessThanOrEqual(32);
  });

  it('pins the SAS program id', () => {
    expect(SAS_PROGRAM_ID).toBe('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
  });
});

describe('payloadLength', () => {
  it('sums the layout to the 83-byte payload', () => {
    expect(PAYLOAD_LEN).toBe(83);
    expect(payloadLength(SCHEMA_LAYOUT)).toBe(83);
  });

  it('sizes each fixed type', () => {
    expect(payloadLength([0])).toBe(1);
    expect(payloadLength([2])).toBe(4);
    expect(payloadLength([4])).toBe(16);
    expect(payloadLength([8])).toBe(8);
    expect(payloadLength([])).toBe(0);
  });

  it('throws on a variable-size type (String = 12)', () => {
    expect(() => payloadLength([0, 12])).toThrow(/type id 12/);
  });
});

describe('SAS program binary fixture', () => {
  it('matches the sha256 recorded in SOURCE.md', () => {
    const row = readFileSync(SOURCE_MD, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('| sha256'));
    const recorded = row?.match(/`([0-9a-f]{64})`/)?.[1];
    expect(recorded).toBeDefined();
    const actual = createHash('sha256').update(readFileSync(SAS_SO_PATH)).digest('hex');
    expect(actual).toBe(recorded);
  });
});
