import type { Address } from '@solana/kit';
import { SCHEMA_FIELD_NAMES, SCHEMA_LAYOUT } from './sas-schema.ts';

/** The parts of an on-chain SAS credential the setup checks. */
export type FoundCredential = {
  authority: Address;
  authorizedSigners: readonly Address[];
};

/** The parts of an on-chain SAS schema the setup checks. */
export type FoundSchema = {
  layout: readonly number[];
  fieldNames: readonly string[];
  isPaused: boolean;
};

export type SetupStep = 'create_credential' | 'create_schema';

export type SetupErrorCode =
  | 'credential_authority_mismatch'
  | 'credential_signers_mismatch'
  | 'schema_layout_mismatch'
  | 'schema_fields_mismatch'
  | 'schema_paused';

export type PlanResult =
  | { ok: true; steps: SetupStep[] }
  | { ok: false; error: { code: SetupErrorCode; message: string } };

/**
 * Decide what the setup must create, or why the existing accounts are wrong.
 *
 * Existing accounts are never changed: a mismatch is an error for a human to
 * look at. The oracle's PDA must be the credential's **only** signer, because
 * any other signer could write attestations the oracle never checked.
 */
export function planSasSetup(
  found: { credential: FoundCredential | null; schema: FoundSchema | null },
  expected: { authority: Address; sasSigner: Address },
): PlanResult {
  const steps: SetupStep[] = [];
  if (found.credential === null) {
    steps.push('create_credential');
  } else {
    const error = checkCredential(found.credential, expected);
    if (error) return { ok: false, error };
  }
  if (found.schema === null) {
    steps.push('create_schema');
  } else {
    const error = checkSchema(found.schema);
    if (error) return { ok: false, error };
  }
  return { ok: true, steps };
}

type PlanError = { code: SetupErrorCode; message: string };

function checkCredential(
  credential: FoundCredential,
  expected: { authority: Address; sasSigner: Address },
): PlanError | undefined {
  if (credential.authority !== expected.authority) {
    return {
      code: 'credential_authority_mismatch',
      message: `credential authority is ${credential.authority}, expected ${expected.authority}`,
    };
  }
  if (!sameList(credential.authorizedSigners, [expected.sasSigner])) {
    return {
      code: 'credential_signers_mismatch',
      message: `credential signers are [${credential.authorizedSigners.join(', ')}], expected [${expected.sasSigner}]`,
    };
  }
  return undefined;
}

function checkSchema(schema: FoundSchema): PlanError | undefined {
  if (!sameList(schema.layout, SCHEMA_LAYOUT)) {
    return {
      code: 'schema_layout_mismatch',
      message: `schema layout is [${schema.layout.join(',')}], expected [${SCHEMA_LAYOUT.join(',')}]`,
    };
  }
  if (!sameList(schema.fieldNames, SCHEMA_FIELD_NAMES)) {
    return {
      code: 'schema_fields_mismatch',
      message: `schema field names are [${schema.fieldNames.join(',')}], expected [${SCHEMA_FIELD_NAMES.join(',')}]`,
    };
  }
  if (schema.isPaused) {
    return { code: 'schema_paused', message: 'schema is paused' };
  }
  return undefined;
}

function sameList<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length && actual.every((item, i) => item === expected[i]);
}
