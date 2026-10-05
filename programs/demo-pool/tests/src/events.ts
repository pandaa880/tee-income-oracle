// Event decoders for the pool tests. The generated client doesn't render
// events, so decode them here: discriminators come from the Anchor IDL, fields
// follow the `#[event]` structs in programs/demo-pool/src/events.rs.
import {
  type Address,
  getAddressDecoder,
  getI64Decoder,
  getStructDecoder,
  getU64Decoder,
  getU8Decoder,
} from '@solana/kit';
import { type PoolParams, getPoolParamsDecoder } from '@tio/demo-pool-client';
import { type Harness, eventPayloads } from '@tio/oracle-tests/harness';
import { eventBodyOf } from '@tio/oracle-tests/events';

const IDL_PATH = new URL('../../../../target/idl/demo_pool.json', import.meta.url);

// Body sizes: Pubkey = 32, PoolParams = 32 + 3 * 8 + 3 * 4 + 32 = 100.
const POOL_PARAMS_LEN = 100;
const POOL_CREATED_LEN = 32 * 2 + 1 + 32 * 3 + POOL_PARAMS_LEN;
const POOL_UPDATED_LEN = 32 + POOL_PARAMS_LEN;
const BORROWED_LEN = 32 * 2 + 8 + 1 + 1 + 8;
const REPAID_LEN = 32 * 2 + 8;

export type PoolCreatedEvent = {
  pool: Address;
  admin: Address;
  poolId: number;
  mint: Address;
  credential: Address;
  schema: Address;
  params: PoolParams;
};

export type PoolUpdatedEvent = { pool: Address; params: PoolParams };

export type BorrowedEvent = {
  pool: Address;
  borrower: Address;
  amount: bigint;
  tier: number;
  measurementId: number;
  attestationIssuedAt: bigint;
};

export type RepaidEvent = { pool: Address; borrower: Address; amount: bigint };

const poolCreatedDecoder = getStructDecoder([
  ['pool', getAddressDecoder()],
  ['admin', getAddressDecoder()],
  ['poolId', getU8Decoder()],
  ['mint', getAddressDecoder()],
  ['credential', getAddressDecoder()],
  ['schema', getAddressDecoder()],
  ['params', getPoolParamsDecoder()],
]);

const poolUpdatedDecoder = getStructDecoder([
  ['pool', getAddressDecoder()],
  ['params', getPoolParamsDecoder()],
]);

const borrowedDecoder = getStructDecoder([
  ['pool', getAddressDecoder()],
  ['borrower', getAddressDecoder()],
  ['amount', getU64Decoder()],
  ['tier', getU8Decoder()],
  ['measurementId', getU8Decoder()],
  ['attestationIssuedAt', getI64Decoder()],
]);

const repaidDecoder = getStructDecoder([
  ['pool', getAddressDecoder()],
  ['borrower', getAddressDecoder()],
  ['amount', getU64Decoder()],
]);

export function parsePoolCreatedEvent(payload: Uint8Array): PoolCreatedEvent {
  return poolCreatedDecoder.decode(eventBodyOf(IDL_PATH, 'PoolCreated', payload, POOL_CREATED_LEN));
}

export function parsePoolUpdatedEvent(payload: Uint8Array): PoolUpdatedEvent {
  return poolUpdatedDecoder.decode(eventBodyOf(IDL_PATH, 'PoolUpdated', payload, POOL_UPDATED_LEN));
}

export function parseBorrowedEvent(payload: Uint8Array): BorrowedEvent {
  return borrowedDecoder.decode(eventBodyOf(IDL_PATH, 'Borrowed', payload, BORROWED_LEN));
}

export function parseRepaidEvent(payload: Uint8Array): RepaidEvent {
  return repaidDecoder.decode(eventBodyOf(IDL_PATH, 'Repaid', payload, REPAID_LEN));
}

/** The raw bytes of the one event the transaction emitted; throws if there are none or several. */
export async function singleEvent(h: Harness, signature: string): Promise<Uint8Array> {
  const payloads = await eventPayloads(h, signature);
  const [first] = payloads;
  if (payloads.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one event, the transaction emitted ${payloads.length}`);
  }
  return first;
}
