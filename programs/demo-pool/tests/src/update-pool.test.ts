import { generateKeyPairSigner } from '@solana/kit';
import {
  DEMO_POOL_ERROR__AMOUNT_OVER_TIER_LIMIT,
  DEMO_POOL_ERROR__INVALID_TIER_LIMITS,
  DEMO_POOL_ERROR__MEASUREMENT_NOT_APPROVED,
  DEMO_POOL_ERROR__NOT_ADMIN,
  fetchPool,
} from '@tio/demo-pool-client';
import { sendExpectingFailure } from '@tio/oracle-tests/attest-fixture';
import { send } from '@tio/oracle-tests/harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANCHOR_ACCOUNT_NOT_INITIALIZED,
  ANCHOR_ACCOUNT_NOT_SIGNER,
  expectError,
} from './assertions.ts';
import { parsePoolUpdatedEvent, singleEvent } from './events.ts';
import {
  type PoolFixture,
  type PoolRef,
  approve,
  borrow,
  borrowFailure,
  createPool,
  demoteSigner,
  fundVault,
  fundedPool,
  poolParams,
  prepare,
  startPoolFixture,
  updatePoolInstruction,
} from './pool-fixture.ts';

describe('update_pool', () => {
  let f: PoolFixture;

  beforeAll(async () => {
    f = await startPoolFixture();
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  /** Every tunable differs from `poolParams` defaults. */
  function changedParams() {
    return poolParams(f, {
      policyHash: new Uint8Array(32).fill(0x44),
      tierLimits: [90n, 80n, 70n],
      maxAgeSecs: 11,
      maxWindowAgeSecs: 22,
      minWindowSecs: 33,
      approvedMeasurements: approve(1, 9, 255),
    });
  }

  async function paramsOf(pool: PoolRef) {
    return (await fetchPool(f.h.rpc, pool.address)).data.params;
  }

  it('replaces_every_tunable', async () => {
    const pool = await createPool(f);
    const next = changedParams();
    await send(f.h, pool.admin, [updatePoolInstruction(pool, next)]);
    expect(await paramsOf(pool)).toEqual(next);
  });

  it('leaves_the_immutable_fields_unchanged', async () => {
    const pool = await createPool(f, { poolId: 5 });
    const before = (await fetchPool(f.h.rpc, pool.address)).data;
    await send(f.h, pool.admin, [updatePoolInstruction(pool, changedParams())]);
    const after = (await fetchPool(f.h.rpc, pool.address)).data;
    expect({ ...after, params: before.params }).toEqual(before);
    expect(after).toMatchObject({ poolId: 5, admin: pool.admin.address, mint: f.mint });
  });

  it('emits_pool_updated', async () => {
    const pool = await createPool(f);
    const next = changedParams();
    const signature = await send(f.h, pool.admin, [updatePoolInstruction(pool, next)]);
    const event = parsePoolUpdatedEvent(await singleEvent(f.h, signature));
    expect(event).toEqual({ pool: pool.address, params: next });
  });

  it('rejects_with_not_admin_when_another_signer_updates', async () => {
    const pool = await createPool(f);
    const stranger = await generateKeyPairSigner();
    f.h.surfnet.fundSol(stranger.address, 1_000_000_000);
    const failure = await sendExpectingFailure(f, stranger, [
      updatePoolInstruction(pool, changedParams(), stranger),
    ]);
    expectError(failure, DEMO_POOL_ERROR__NOT_ADMIN);
    expect(await paramsOf(pool)).toEqual(pool.params);
  });

  it.each([
    ['a_is_zero', [0n, 0n, 0n]],
    ['b_exceeds_a', [1n, 2n, 0n]],
    ['c_exceeds_b', [3n, 1n, 2n]],
    ['c_exceeds_b_while_b_is_zero', [3n, 0n, 1n]],
  ])('rejects_with_invalid_tier_limits_when_%s', async (_name, tierLimits) => {
    const pool = await createPool(f);
    const failure = await sendExpectingFailure(f, pool.admin, [
      updatePoolInstruction(pool, poolParams(f, { tierLimits })),
    ]);
    expectError(failure, DEMO_POOL_ERROR__INVALID_TIER_LIMITS);
    expect(await paramsOf(pool)).toEqual(pool.params);
  });

  it('accepts_equal_and_tier_a_only_limits', async () => {
    const pool = await createPool(f);
    await send(f.h, pool.admin, [
      updatePoolInstruction(pool, poolParams(f, { tierLimits: [2n, 2n, 2n] })),
    ]);
    await send(f.h, pool.admin, [
      updatePoolInstruction(pool, poolParams(f, { tierLimits: [5n, 0n, 0n] })),
    ]);
    expect((await paramsOf(pool)).tierLimits).toEqual([5n, 0n, 0n]);
  });

  it('reports_not_admin_before_invalid_tier_limits_when_both_apply', async () => {
    const pool = await createPool(f);
    const stranger = await generateKeyPairSigner();
    f.h.surfnet.fundSol(stranger.address, 1_000_000_000);
    const failure = await sendExpectingFailure(f, stranger, [
      updatePoolInstruction(pool, poolParams(f, { tierLimits: [0n, 0n, 0n] }), stranger),
    ]);
    expectError(failure, DEMO_POOL_ERROR__NOT_ADMIN);
  });

  it('rejects_with_not_signer_when_the_admin_does_not_sign', async () => {
    const pool = await createPool(f);
    const instruction = demoteSigner(
      updatePoolInstruction(pool, changedParams()),
      pool.admin.address,
    );
    const failure = await sendExpectingFailure(f, f.h.payer, [instruction]);
    expectError(failure, ANCHOR_ACCOUNT_NOT_SIGNER);
    expect(await paramsOf(pool)).toEqual(pool.params);
  });

  it('rejects_with_not_initialized_when_the_pool_does_not_exist', async () => {
    const pool = await createPool(f);
    const missing = { ...pool, address: (await generateKeyPairSigner()).address };
    const failure = await sendExpectingFailure(f, pool.admin, [
      updatePoolInstruction(missing, changedParams()),
    ]);
    expectError(failure, ANCHOR_ACCOUNT_NOT_INITIALIZED);
  });

  it('stops_borrowing_after_the_measurement_bitmap_is_cleared', async () => {
    const pool = await fundedPool(f);
    const before = await prepare(f);
    await borrow(f, { pool, borrower: before, amount: 1_000_000n });
    await send(f.h, pool.admin, [
      updatePoolInstruction(pool, poolParams(f, { approvedMeasurements: approve() })),
    ]);
    const after = await prepare(f);
    const failure = await borrowFailure(f, { pool, borrower: after, amount: 1_000_000n });
    expectError(failure, DEMO_POOL_ERROR__MEASUREMENT_NOT_APPROVED);
  });

  it('applies_a_raised_tier_limit_to_the_next_borrow', async () => {
    const pool = await createPool(f);
    await fundVault(f, pool, 100_000_000n);
    const borrower = await prepare(f);
    const failure = await borrowFailure(f, { pool, borrower, amount: 4_000_000n });
    expectError(failure, DEMO_POOL_ERROR__AMOUNT_OVER_TIER_LIMIT);
    await send(f.h, pool.admin, [
      updatePoolInstruction(
        pool,
        poolParams(f, { tierLimits: [5_000_000n, 2_000_000n, 1_000_000n] }),
      ),
    ]);
    await borrow(f, { pool, borrower, amount: 4_000_000n });
  });
});
