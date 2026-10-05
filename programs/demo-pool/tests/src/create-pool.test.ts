import { AccountState, TOKEN_PROGRAM_ADDRESS, fetchToken } from '@solana-program/token';
import { generateKeyPairSigner } from '@solana/kit';
import {
  DEMO_POOL_ERROR__INVALID_TIER_LIMITS,
  DEMO_POOL_PROGRAM_ADDRESS,
  fetchMaybePool,
  fetchPool,
  findPoolPda,
  findVaultPda,
  getPoolSize,
} from '@tio/demo-pool-client';
import { fetchRaw } from '@tio/oracle-tests/attest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANCHOR_ACCOUNT_NOT_INITIALIZED,
  ANCHOR_ACCOUNT_NOT_SIGNER,
  ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM,
  ANCHOR_CONSTRAINT_SEEDS,
  SYSTEM_ACCOUNT_ALREADY_IN_USE,
  expectError,
} from './assertions.ts';
import { parsePoolCreatedEvent, singleEvent } from './events.ts';
import {
  type PoolFixture,
  type PoolRef,
  approve,
  createPool,
  createPoolFailure,
  createPoolSignature,
  fundedSigner,
  poolParams,
  startPoolFixture,
} from './pool-fixture.ts';

// Rent-exempt minimum for the 240-byte pool is about 2.1 M lamports; 1 is far below, 10 M far above.
const BELOW_RENT = 1;
const ABOVE_RENT = 10_000_000;

describe('create_pool', () => {
  let f: PoolFixture;

  beforeAll(async () => {
    f = await startPoolFixture();
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  async function poolExists(pool: PoolRef): Promise<boolean> {
    return (await fetchMaybePool(f.h.rpc, pool.address)).exists;
  }

  it('creates_the_pool_account_with_the_given_config', async () => {
    const pool = await createPool(f, {
      poolId: 3,
      params: {
        policyHash: new Uint8Array(32).fill(0x5a),
        tierLimits: [900n, 500n, 100n],
        maxAgeSecs: 1_234,
        maxWindowAgeSecs: 5_678,
        minWindowSecs: 9_012,
        approvedMeasurements: approve(0, 7, 8, 254),
      },
    });
    const [, bump] = await findPoolPda({ admin: pool.admin.address, poolId: 3 });
    const [, vaultBump] = await findVaultPda({ pool: pool.address });
    const { data } = await fetchPool(f.h.rpc, pool.address);
    expect(data).toMatchObject({
      version: 1,
      bump,
      vaultBump,
      poolId: 3,
      admin: pool.admin.address,
      mint: f.mint,
      credential: f.credential,
      schema: f.schema,
    });
    expect(data.params).toEqual(pool.params);
  });

  it('creates_the_pool_account_owned_by_the_program_with_the_final_size', async () => {
    const pool = await createPool(f);
    const raw = await fetchRaw(f.h, pool.address);
    expect(raw?.owner).toBe(DEMO_POOL_PROGRAM_ADDRESS);
    expect(raw?.data.length).toBe(getPoolSize());
  });

  it('creates_an_empty_vault_owned_by_the_pool_for_the_pool_mint', async () => {
    const pool = await createPool(f);
    const vault = (await fetchToken(f.h.rpc, pool.vault)).data;
    expect(vault.mint).toBe(f.mint);
    expect(vault.owner).toBe(pool.address);
    expect(vault.amount).toBe(0n);
    expect(vault.state).toBe(AccountState.Initialized);
    expect((await fetchRaw(f.h, pool.vault))?.owner).toBe(TOKEN_PROGRAM_ADDRESS);
  });

  it('emits_pool_created', async () => {
    const { pool, signature } = await createPoolSignature(f, { poolId: 4 });
    const event = parsePoolCreatedEvent(await singleEvent(f.h, signature));
    expect(event).toEqual({
      pool: pool.address,
      admin: pool.admin.address,
      poolId: 4,
      mint: f.mint,
      credential: f.credential,
      schema: f.schema,
      params: pool.params,
    });
  });

  it('accepts_equal_tier_limits', async () => {
    const pool = await createPool(f, { params: { tierLimits: [2n, 2n, 2n] } });
    expect((await fetchPool(f.h.rpc, pool.address)).data.params.tierLimits).toEqual([2n, 2n, 2n]);
  });

  it('accepts_a_pool_that_lends_to_tier_a_only', async () => {
    const pool = await createPool(f, { params: { tierLimits: [5n, 0n, 0n] } });
    expect((await fetchPool(f.h.rpc, pool.address)).data.params.tierLimits).toEqual([5n, 0n, 0n]);
  });

  it('creates_two_pools_with_different_ids_for_one_admin', async () => {
    const admin = await fundedSigner(f);
    const first = await createPool(f, { admin, poolId: 0 });
    const second = await createPool(f, { admin, poolId: 1 });
    expect(first.address).not.toBe(second.address);
    expect((await fetchPool(f.h.rpc, first.address)).data.poolId).toBe(0);
    expect((await fetchPool(f.h.rpc, second.address)).data.poolId).toBe(1);
  });

  it('creates_the_same_pool_id_for_two_admins', async () => {
    const first = await createPool(f, { poolId: 9 });
    const second = await createPool(f, { poolId: 9 });
    expect(first.address).not.toBe(second.address);
    expect((await fetchPool(f.h.rpc, first.address)).data.admin).toBe(first.admin.address);
    expect((await fetchPool(f.h.rpc, second.address)).data.admin).toBe(second.admin.address);
  });

  it('fails_with_already_in_use_when_the_pool_id_exists_for_the_admin', async () => {
    const admin = await fundedSigner(f);
    await createPool(f, { admin, poolId: 2 });
    const failure = await createPoolFailure(f, { admin, poolId: 2 });
    expectError(failure, SYSTEM_ACCOUNT_ALREADY_IN_USE);
  });

  it.each([
    ['a_is_zero', [0n, 0n, 0n]],
    ['b_exceeds_a', [1n, 2n, 0n]],
    ['c_exceeds_b', [3n, 1n, 2n]],
    ['c_exceeds_b_while_b_is_zero', [3n, 0n, 1n]],
  ])('fails_with_invalid_tier_limits_when_%s', async (_name, tierLimits) => {
    const admin = await fundedSigner(f);
    const failure = await createPoolFailure(f, { admin, params: { tierLimits } });
    expectError(failure, DEMO_POOL_ERROR__INVALID_TIER_LIMITS);
    const [address] = await findPoolPda({ admin: admin.address, poolId: 0 });
    expect((await fetchMaybePool(f.h.rpc, address)).exists).toBe(false);
  });

  it('fails_with_seeds_error_when_the_pool_address_belongs_to_another_pool_id', async () => {
    const admin = await fundedSigner(f);
    const [otherId] = await findPoolPda({ admin: admin.address, poolId: 7 });
    const failure = await createPoolFailure(f, {
      admin,
      poolId: 0,
      accounts: { pool: otherId },
    });
    expectError(failure, ANCHOR_CONSTRAINT_SEEDS);
    expect((await fetchMaybePool(f.h.rpc, otherId)).exists).toBe(false);
  });

  it('fails_with_seeds_error_when_the_pool_address_belongs_to_another_admin', async () => {
    const admin = await fundedSigner(f);
    const other = await generateKeyPairSigner();
    const [theirs] = await findPoolPda({ admin: other.address, poolId: 0 });
    const failure = await createPoolFailure(f, { admin, accounts: { pool: theirs } });
    expectError(failure, ANCHOR_CONSTRAINT_SEEDS);
    expect((await fetchMaybePool(f.h.rpc, theirs)).exists).toBe(false);
  });

  it('fails_with_seeds_error_when_the_vault_address_belongs_to_another_pool', async () => {
    const existing = await createPool(f);
    const failure = await createPoolFailure(f, { accounts: { vault: existing.vault } });
    expectError(failure, ANCHOR_CONSTRAINT_SEEDS);
  });

  it('fails_with_not_initialized_when_the_mint_account_does_not_exist', async () => {
    const mint = (await generateKeyPairSigner()).address;
    const failure = await createPoolFailure(f, { mint });
    expectError(failure, ANCHOR_ACCOUNT_NOT_INITIALIZED);
  });

  it('fails_with_wrong_owner_when_the_mint_is_not_a_token_program_account', async () => {
    const mint = (await fundedSigner(f)).address;
    const failure = await createPoolFailure(f, { mint });
    expectError(failure, ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM);
  });

  it('fails_with_not_signer_when_the_admin_does_not_sign', async () => {
    const failure = await createPoolFailure(f, { adminSigns: false });
    expectError(failure, ANCHOR_ACCOUNT_NOT_SIGNER);
  });

  describe.each([
    ['below_rent', BELOW_RENT],
    ['above_rent', ABOVE_RENT],
  ])('pre-funded addresses (%s)', (_name, lamports) => {
    it('creates_the_pool_when_its_address_already_holds_lamports', async () => {
      const admin = await fundedSigner(f);
      const [address] = await findPoolPda({ admin: admin.address, poolId: 0 });
      f.h.surfnet.fundSol(address, lamports);
      const pool = await createPool(f, { admin });
      const { data } = await fetchPool(f.h.rpc, address);
      expect(data).toMatchObject({ version: 1, admin: admin.address, poolId: 0, mint: f.mint });
      expect(data.params).toEqual(poolParams(f));
      expect((await fetchRaw(f.h, address))?.owner).toBe(DEMO_POOL_PROGRAM_ADDRESS);
      expect(await poolExists(pool)).toBe(true);
    });

    it('creates_the_vault_when_its_address_already_holds_lamports', async () => {
      const admin = await fundedSigner(f);
      const [address] = await findPoolPda({ admin: admin.address, poolId: 0 });
      const [vaultAddress] = await findVaultPda({ pool: address });
      f.h.surfnet.fundSol(vaultAddress, lamports);
      const pool = await createPool(f, { admin });
      const vault = (await fetchToken(f.h.rpc, pool.vault)).data;
      expect(vault).toMatchObject({ mint: f.mint, owner: pool.address, amount: 0n });
      expect((await fetchRaw(f.h, pool.vault))?.owner).toBe(TOKEN_PROGRAM_ADDRESS);
    });
  });
});
