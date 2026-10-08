import { fileURLToPath } from 'node:url';
import { address } from '@solana/kit';
import { SchemaDataType } from 'sas-lib';

/** SAS program id, the same on devnet and mainnet (FORMATS §7). */
export const SAS_PROGRAM_ID = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');

/** The deployed SAS binary dumped from devnet; see `test-fixtures/sas/SOURCE.md`. */
export const SAS_SO_PATH = fileURLToPath(
  new URL('../../test-fixtures/sas/sas.20261004.so', import.meta.url),
);

// Names are PDA seeds, so they must stay within 32 bytes. Changing one moves
// the credential or schema to a new address.
export const CREDENTIAL_NAME = 'tee-income-oracle';
export const SCHEMA_NAME = 'tio-income-tier';
export const SCHEMA_VERSION = 1;
export const SCHEMA_DESCRIPTION = 'TEE Income Oracle attestation payload v1 (FORMATS section 7)';

/**
 * SAS layout of the 83-byte payload (FORMATS §7). SAS has no fixed-size
 * arrays, so each 32-byte hash is two U128s. Stored on chain as type ids
 * `[0,0,0,4,4,4,4,8,2,2]`.
 */
export const SCHEMA_LAYOUT: readonly SchemaDataType[] = [
  SchemaDataType.U8, // tier
  SchemaDataType.U8, // proof_type
  SchemaDataType.U8, // measurement_id
  SchemaDataType.U128, // policy_hash_lo
  SchemaDataType.U128, // policy_hash_hi
  SchemaDataType.U128, // consent_hash_lo
  SchemaDataType.U128, // consent_hash_hi
  SchemaDataType.I64, // issued_at
  SchemaDataType.U32, // window_from
  SchemaDataType.U32, // window_to
];
export const SCHEMA_FIELD_NAMES: readonly string[] = [
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
];
export const PAYLOAD_LEN = 83;

/** Byte size of each fixed-size SAS type id (variable-size types are absent). */
const FIXED_TYPE_SIZES: ReadonlyMap<number, number> = new Map([
  [0, 1], // U8
  [1, 2], // U16
  [2, 4], // U32
  [3, 8], // U64
  [4, 16], // U128
  [5, 1], // I8
  [6, 2], // I16
  [7, 4], // I32
  [8, 8], // I64
  [9, 16], // I128
  [10, 1], // Bool
]);

/**
 * Total payload length of a SAS layout made only of fixed-size types.
 *
 * @throws Error if the layout holds a variable-size or unknown type id.
 */
export function payloadLength(layout: readonly number[]): number {
  let total = 0;
  for (const typeId of layout) {
    const size = FIXED_TYPE_SIZES.get(typeId);
    if (size === undefined) {
      throw new Error(`SAS type id ${typeId} has no fixed size`);
    }
    total += size;
  }
  return total;
}
