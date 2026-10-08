import {
  DEMO_POOL_ERROR__AMOUNT_OVER_TIER_LIMIT,
  DEMO_POOL_ERROR__TIER_NOT_ACCEPTED,
  DEMO_POOL_PROGRAM_ADDRESS,
  fetchLoan,
  findLoanPda,
  getLoanSize,
} from '@tio/demo-pool-client';
import { fetchRaw, timeTravel } from '@tio/oracle-tests/attest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectError } from './assertions.ts';
import { parseBorrowedEvent, singleEvent } from './events.ts';
import {
  type PoolFixture,
  type PoolRef,
  BIG_VAULT,
  attest,
  borrow,
  borrowFailure,
  fundedPool,
  lamportsOf,
  prepare,
  startPoolFixture,
} from './pool-fixture.ts';
import { tokenBalance } from './token.ts';

const TIER_A = 1;
const TIER_B = 2;
const TIER_C = 3;
const TOKEN = 1_000_000n;

describe('borrow', () => {
  let f: PoolFixture;
  let pool: PoolRef;

  beforeAll(async () => {
    f = await startPoolFixture();
    pool = await fundedPool(f);
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  it.each([
    ['a', TIER_A, 3n * TOKEN],
    ['b', TIER_B, 2n * TOKEN],
    ['c', TIER_C, 1n * TOKEN],
  ])('lends_up_to_the_limit_of_tier_%s', async (_name, tier, limit) => {
    const borrower = await prepare(f, { tier });
    const vaultBefore = await tokenBalance(f.h, pool.vault);
    await borrow(f, { pool, borrower, amount: limit });
    expect(await tokenBalance(f.h, pool.vault)).toBe(vaultBefore - limit);
    expect(await tokenBalance(f.h, borrower.token)).toBe(limit);
    const [loanAddress, bump] = await findLoanPda({
      pool: pool.address,
      borrower: borrower.signer.address,
    });
    const loan = (await fetchLoan(f.h.rpc, loanAddress)).data;
    expect(loan).toMatchObject({
      version: 1,
      bump,
      tier,
      pool: pool.address,
      borrower: borrower.signer.address,
      rentPayer: borrower.signer.address,
      amount: limit,
      borrowedAt: borrower.now,
      attestationIssuedAt: borrower.now,
    });
  });

  it('lends_less_than_the_limit', async () => {
    const borrower = await prepare(f, { tier: TIER_A });
    await borrow(f, { pool, borrower, amount: 1n });
    expect(await tokenBalance(f.h, borrower.token)).toBe(1n);
  });

  it('creates_the_loan_account_owned_by_the_program_with_the_final_size', async () => {
    const borrower = await prepare(f);
    await borrow(f, { pool, borrower, amount: TOKEN });
    const [loanAddress] = await findLoanPda({
      pool: pool.address,
      borrower: borrower.signer.address,
    });
    const raw = await fetchRaw(f.h, loanAddress);
    expect(raw?.owner).toBe(DEMO_POOL_PROGRAM_ADDRESS);
    expect(raw?.data.length).toBe(getLoanSize());
  });

  it('emits_borrowed', async () => {
    const borrower = await prepare(f, { tier: TIER_B });
    const signature = await borrow(f, { pool, borrower, amount: TOKEN });
    const event = parseBorrowedEvent(await singleEvent(f.h, signature));
    expect(event).toEqual({
      pool: pool.address,
      borrower: borrower.signer.address,
      amount: TOKEN,
      tier: TIER_B,
      measurementId: f.entryId,
      attestationIssuedAt: borrower.now,
    });
  });

  it('records_the_relayer_as_rent_payer_and_charges_the_borrower_nothing', async () => {
    const borrower = await prepare(f);
    const solBefore = await lamportsOf(f, borrower.signer.address);
    const relayerBefore = await lamportsOf(f, f.relayer.address);
    await borrow(f, { pool, borrower, amount: TOKEN, payer: f.relayer });
    const [loanAddress] = await findLoanPda({
      pool: pool.address,
      borrower: borrower.signer.address,
    });
    const loan = (await fetchLoan(f.h.rpc, loanAddress)).data;
    expect(loan.rentPayer).toBe(f.relayer.address);
    expect(loan.borrower).toBe(borrower.signer.address);
    expect(await lamportsOf(f, borrower.signer.address)).toBe(solBefore);
    expect(await lamportsOf(f, f.relayer.address)).toBeLessThan(relayerBefore);
    expect(await tokenBalance(f.h, borrower.token)).toBe(TOKEN);
  });

  it('honours_a_refreshed_attestation_with_a_better_tier', async () => {
    const borrower = await prepare(f, { tier: TIER_C });
    const tooMuch = await borrowFailure(f, { pool, borrower, amount: 3n * TOKEN });
    expectError(tooMuch, DEMO_POOL_ERROR__AMOUNT_OVER_TIER_LIMIT);
    const later = borrower.now + 100n;
    await timeTravel(f.h, later);
    await attest(f, borrower.signer.address, { now: later, tier: TIER_A });
    await borrow(f, { pool, borrower, amount: 3n * TOKEN });
    expect(await tokenBalance(f.h, borrower.token)).toBe(3n * TOKEN);
  });
});

describe('borrow: portability across pools (one attestation, two lenders)', () => {
  let f: PoolFixture;
  let poolA: PoolRef;
  let poolB: PoolRef;
  let aOnly: PoolRef;

  beforeAll(async () => {
    f = await startPoolFixture();
    poolA = await fundedPool(f, { params: { tierLimits: [3n * TOKEN, 2n * TOKEN, TOKEN] } });
    poolB = await fundedPool(f, {
      params: { tierLimits: [5n * TOKEN, TOKEN, TOKEN / 2n] },
    });
    aOnly = await fundedPool(f, { params: { tierLimits: [4n * TOKEN, 0n, 0n] } });
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  it('lends_to_the_same_wallet_from_both_pools_on_one_attestation', async () => {
    const borrower = await prepare(f, { tier: TIER_B });
    await borrow(f, { pool: poolA, borrower, amount: 2n * TOKEN });
    await borrow(f, { pool: poolB, borrower, amount: TOKEN });
    expect(await tokenBalance(f.h, borrower.token)).toBe(3n * TOKEN);
    expect(await tokenBalance(f.h, poolA.vault)).toBe(BIG_VAULT - 2n * TOKEN);
    expect(await tokenBalance(f.h, poolB.vault)).toBe(BIG_VAULT - TOKEN);
  });

  it('applies_each_pools_own_limit_to_the_same_attestation', async () => {
    const borrower = await prepare(f, { tier: TIER_B });
    const failure = await borrowFailure(f, { pool: poolB, borrower, amount: (3n * TOKEN) / 2n });
    expectError(failure, DEMO_POOL_ERROR__AMOUNT_OVER_TIER_LIMIT);
    await borrow(f, { pool: poolA, borrower, amount: (3n * TOKEN) / 2n });
    expect(await tokenBalance(f.h, borrower.token)).toBe((3n * TOKEN) / 2n);
  });

  it('refuses_a_tier_b_wallet_at_a_pool_that_lends_to_tier_a_only', async () => {
    const borrower = await prepare(f, { tier: TIER_B });
    const failure = await borrowFailure(f, { pool: aOnly, borrower, amount: TOKEN });
    expectError(failure, DEMO_POOL_ERROR__TIER_NOT_ACCEPTED);
  });

  it('lends_a_tier_a_wallet_at_a_pool_that_lends_to_tier_a_only', async () => {
    const borrower = await prepare(f, { tier: TIER_A });
    await borrow(f, { pool: aOnly, borrower, amount: 4n * TOKEN });
    expect(await tokenBalance(f.h, borrower.token)).toBe(4n * TOKEN);
  });
});
