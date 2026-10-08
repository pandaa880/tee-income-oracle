import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  planSasSetup,
  type FoundCredential,
  type FoundSchema,
  type PlanResult,
  type SetupErrorCode,
} from './plan-setup.ts';
import { SCHEMA_FIELD_NAMES, SCHEMA_LAYOUT } from './sas-schema.ts';

const AUTHORITY = '11111111111111111111111111111112' as Address;
const SAS_SIGNER = 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8' as Address;
const OTHER = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;
const EXPECTED = { authority: AUTHORITY, sasSigner: SAS_SIGNER };

function goodCredential(overrides: Partial<FoundCredential> = {}): FoundCredential {
  return { authority: AUTHORITY, authorizedSigners: [SAS_SIGNER], ...overrides };
}
function goodSchema(overrides: Partial<FoundSchema> = {}): FoundSchema {
  return {
    layout: [...SCHEMA_LAYOUT],
    fieldNames: [...SCHEMA_FIELD_NAMES],
    isPaused: false,
    ...overrides,
  };
}
function plan(credential: FoundCredential | null, schema: FoundSchema | null): PlanResult {
  return planSasSetup({ credential, schema }, EXPECTED);
}
function expectError(result: PlanResult, code: SetupErrorCode): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.message.length).toBeGreaterThan(0);
}

describe('planSasSetup success paths', () => {
  it('needs nothing when credential and schema match (baseline)', () => {
    expect(plan(goodCredential(), goodSchema())).toEqual({ ok: true, steps: [] });
  });

  it('creates credential then schema when both are missing', () => {
    expect(plan(null, null)).toEqual({
      ok: true,
      steps: ['create_credential', 'create_schema'],
    });
  });

  it('creates only the schema when the credential matches and schema is missing', () => {
    expect(plan(goodCredential(), null)).toEqual({ ok: true, steps: ['create_schema'] });
  });
});

describe('planSasSetup credential checks', () => {
  it('rejects_credential_with_other_authority', () => {
    expect(plan(goodCredential(), goodSchema()).ok).toBe(true);
    expectError(
      plan(goodCredential({ authority: OTHER }), goodSchema()),
      'credential_authority_mismatch',
    );
  });

  it('rejects_extra_authorized_signer', () => {
    expectError(
      plan(goodCredential({ authorizedSigners: [SAS_SIGNER, OTHER] }), goodSchema()),
      'credential_signers_mismatch',
    );
  });

  it('rejects_missing_authorized_signer', () => {
    expectError(
      plan(goodCredential({ authorizedSigners: [] }), goodSchema()),
      'credential_signers_mismatch',
    );
  });

  it('rejects_different_authorized_signer', () => {
    expectError(
      plan(goodCredential({ authorizedSigners: [OTHER] }), goodSchema()),
      'credential_signers_mismatch',
    );
  });

  it('rejects_duplicate_authorized_signer', () => {
    expectError(
      plan(goodCredential({ authorizedSigners: [SAS_SIGNER, SAS_SIGNER] }), goodSchema()),
      'credential_signers_mismatch',
    );
  });

  it('rejects_bad_credential_even_when_schema_is_missing', () => {
    expectError(
      plan(goodCredential({ authorizedSigners: [OTHER] }), null),
      'credential_signers_mismatch',
    );
  });
});

describe('planSasSetup schema checks', () => {
  it('rejects_layout_with_a_changed_element', () => {
    const layout = [...SCHEMA_LAYOUT];
    layout[0] = 2;
    expectError(plan(goodCredential(), goodSchema({ layout })), 'schema_layout_mismatch');
  });

  it('rejects_layout_that_is_longer', () => {
    const layout = [...SCHEMA_LAYOUT, 0];
    expectError(plan(goodCredential(), goodSchema({ layout })), 'schema_layout_mismatch');
  });

  it('rejects_layout_that_is_shorter', () => {
    const layout = SCHEMA_LAYOUT.slice(0, -1);
    expectError(plan(goodCredential(), goodSchema({ layout })), 'schema_layout_mismatch');
  });

  it('rejects_field_names_with_a_changed_element', () => {
    const fieldNames = [...SCHEMA_FIELD_NAMES];
    fieldNames[9] = 'window_end';
    expectError(plan(goodCredential(), goodSchema({ fieldNames })), 'schema_fields_mismatch');
  });

  it('rejects_field_names_that_are_longer', () => {
    const fieldNames = [...SCHEMA_FIELD_NAMES, 'extra'];
    expectError(plan(goodCredential(), goodSchema({ fieldNames })), 'schema_fields_mismatch');
  });

  it('rejects_field_names_that_are_shorter', () => {
    const fieldNames = SCHEMA_FIELD_NAMES.slice(0, -1);
    expectError(plan(goodCredential(), goodSchema({ fieldNames })), 'schema_fields_mismatch');
  });

  it('rejects_paused_schema', () => {
    expectError(plan(goodCredential(), goodSchema({ isPaused: true })), 'schema_paused');
  });
});

describe('planSasSetup check order', () => {
  it('reports credential authority before signers', () => {
    expectError(
      plan(goodCredential({ authority: OTHER, authorizedSigners: [OTHER] }), goodSchema()),
      'credential_authority_mismatch',
    );
  });

  it('reports credential signers before schema layout', () => {
    expectError(
      plan(goodCredential({ authorizedSigners: [OTHER] }), goodSchema({ layout: [0] })),
      'credential_signers_mismatch',
    );
  });

  it('reports schema layout before field names', () => {
    expectError(
      plan(goodCredential(), goodSchema({ layout: [0], fieldNames: ['x'] })),
      'schema_layout_mismatch',
    );
  });

  it('reports schema field names before paused', () => {
    expectError(
      plan(goodCredential(), goodSchema({ fieldNames: ['x'], isPaused: true })),
      'schema_fields_mismatch',
    );
  });
});
