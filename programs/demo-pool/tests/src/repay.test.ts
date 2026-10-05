import { type KeyPairSigner } from '@solana/kit';
import { fetchLoan, fetchMaybeLoan } from '@tio/demo-pool-client';
import { fetchRaw } from '@tio/oracle-tests/attest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANCHOR_ACCOUNT_NOT_INITIALIZED,
  ANCHOR_ACCOUNT_NOT_SIGNER,
  ANCHOR_CONSTRAINT_HAS_ONE,
  ANCHOR_CONSTRAINT_SEEDS,
  ANCHOR_CONSTRAINT_TOKEN_MINT,
  ANCHOR_CONSTRAINT_TOKEN_OWNER,
  SPL_TOKEN_INSUFFICIENT_FUNDS,
  expectError,
} from './assertions.ts';
import { parseRepaidEvent, singleEvent } from './events.ts';
import {
  type Borrower,
  type PoolFixture,
  type PoolRef,
  borrow,
  fundedPool,
  lamportsOf,
  loanAddress,
  newBorrower,
  prepare,
  repay,
  repayFailure,
  startPoolFixture,
} from './pool-fixture.ts';
import { createMint, mintTo, createAta, tokenBalance, transferTokens } from './token.ts';

// SPL Token `InsufficientFunds`.
const TOKEN = 1_000_000n;

describe('repay', () => {
  let f: PoolFixture;
  let pool: PoolRef;

  beforeAll(async () => {
    f = await startPoolFixture();
    pool = await fundedPool(f);
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  /** A borrower with an open loan of `amount` on `pool`. */
  async function borrowerWithLoan(amount = 2n * TOKEN, payer?: KeyPairSigner) {
    const borrower = await prepare(f);
    await borrow(f, { pool, borrower, amount, ...(payer === undefined ? {} : { payer }) });
    return borrower;
  }

  async function loanExists(borrower: Borrower, at: PoolRef = pool): Promise<boolean> {
    return (await fetchMaybeLoan(f.h.rpc, await loanAddress(at, borrower))).exists;
  }

  it('returns_the_principal_from_the_borrower_to_the_vault', async () => {
    const borrower = await borrowerWithLoan(2n * TOKEN);
    const vaultBefore = await tokenBalance(f.h, pool.vault);
    await repay(f, { pool, borrower });
    expect(await tokenBalance(f.h, borrower.token)).toBe(0n);
    expect(await tokenBalance(f.h, pool.vault)).toBe(vaultBefore + 2n * TOKEN);
  });

  it('takes_only_the_principal_when_the_borrower_holds_more', async () => {
    const borrower = await borrowerWithLoan(2n * TOKEN);
    await mintTo(f.h, f.mint, f.mintAuthority, borrower.token, 5n * TOKEN);
    await repay(f, { pool, borrower });
    expect(await tokenBalance(f.h, borrower.token)).toBe(5n * TOKEN);
  });

  it('closes_the_loan_account', async () => {
    const borrower = await borrowerWithLoan();
    expect(await loanExists(borrower)).toBe(true);
    await repay(f, { pool, borrower });
    expect(await loanExists(borrower)).toBe(false);
    expect(await fetchRaw(f.h, await loanAddress(pool, borrower))).toBeUndefined();
  });

  it('refunds_the_rent_to_the_borrower_when_the_borrower_paid_it', async () => {
    const borrower = await borrowerWithLoan();
    const rent = await lamportsOf(f, await loanAddress(pool, borrower));
    const before = await lamportsOf(f, borrower.signer.address);
    await repay(f, { pool, borrower, feePayer: f.h.payer });
    expect(await lamportsOf(f, borrower.signer.address)).toBe(before + rent);
  });

  it('refunds_the_rent_to_the_relayer_that_paid_it', async () => {
    const borrower = await borrowerWithLoan(TOKEN, f.relayer);
    const rent = await lamportsOf(f, await loanAddress(pool, borrower));
    const relayerBefore = await lamportsOf(f, f.relayer.address);
    const borrowerBefore = await lamportsOf(f, borrower.signer.address);
    await repay(f, { pool, borrower, rentPayer: f.relayer.address, feePayer: f.h.payer });
    expect(await lamportsOf(f, f.relayer.address)).toBe(relayerBefore + rent);
    expect(await lamportsOf(f, borrower.signer.address)).toBe(borrowerBefore);
  });

  it('emits_repaid', async () => {
    const borrower = await borrowerWithLoan(2n * TOKEN);
    const signature = await repay(f, { pool, borrower });
    const event = parseRepaidEvent(await singleEvent(f.h, signature));
    expect(event).toEqual({
      pool: pool.address,
      borrower: borrower.signer.address,
      amount: 2n * TOKEN,
    });
  });

  it('lets_the_borrower_borrow_again_after_repaying', async () => {
    const borrower = await borrowerWithLoan(2n * TOKEN);
    await repay(f, { pool, borrower });
    await borrow(f, { pool, borrower, amount: 3n * TOKEN });
    const loan = (await fetchLoan(f.h.rpc, await loanAddress(pool, borrower))).data;
    expect(loan.amount).toBe(3n * TOKEN);
    expect(await tokenBalance(f.h, borrower.token)).toBe(3n * TOKEN);
  });

  it('fails_with_not_initialized_when_the_borrower_has_no_loan', async () => {
    const borrower = await prepare(f);
    const failure = await repayFailure(f, { pool, borrower });
    expectError(failure, ANCHOR_ACCOUNT_NOT_INITIALIZED);
  });

  it('fails_with_not_initialized_when_the_loan_was_already_repaid', async () => {
    const borrower = await borrowerWithLoan();
    await repay(f, { pool, borrower });
    const failure = await repayFailure(f, { pool, borrower });
    expectError(failure, ANCHOR_ACCOUNT_NOT_INITIALIZED);
  });

  it('fails_with_seeds_error_for_another_borrowers_loan', async () => {
    const owner = await borrowerWithLoan();
    const thief = await newBorrower(f);
    await mintTo(f.h, f.mint, f.mintAuthority, thief.token, 5n * TOKEN);
    const failure = await repayFailure(f, {
      pool,
      borrower: thief,
      rentPayer: owner.signer.address,
      accounts: { loan: await loanAddress(pool, owner) },
    });
    expectError(failure, ANCHOR_CONSTRAINT_SEEDS);
    expect(await loanExists(owner)).toBe(true);
    await repay(f, { pool, borrower: owner });
    expect(await loanExists(owner)).toBe(false);
  });

  it('fails_with_seeds_error_when_the_loan_belongs_to_another_pool', async () => {
    const elsewhere = await fundedPool(f);
    const borrower = await borrowerWithLoan();
    await borrow(f, { pool: elsewhere, borrower, amount: TOKEN });
    const failure = await repayFailure(f, {
      pool: elsewhere,
      borrower,
      accounts: { loan: await loanAddress(pool, borrower) },
    });
    expectError(failure, ANCHOR_CONSTRAINT_SEEDS);
  });

  it('fails_with_has_one_error_when_rent_payer_is_not_the_account_that_paid', async () => {
    const borrower = await borrowerWithLoan(TOKEN, f.relayer);
    const failure = await repayFailure(f, { pool, borrower, rentPayer: borrower.signer.address });
    expectError(failure, ANCHOR_CONSTRAINT_HAS_ONE);
    expect(await loanExists(borrower)).toBe(true);
    await repay(f, { pool, borrower, rentPayer: f.relayer.address });
    expect(await loanExists(borrower)).toBe(false);
  });

  it('fails_with_has_one_error_when_the_mint_is_not_the_pool_mint', async () => {
    const borrower = await borrowerWithLoan(TOKEN);
    const otherMint = await createMint(f.h, f.mintAuthority.address);
    const failure = await repayFailure(f, { pool, borrower, accounts: { mint: otherMint } });
    expectError(failure, ANCHOR_CONSTRAINT_HAS_ONE);
    expect(await loanExists(borrower)).toBe(true);
    await repay(f, { pool, borrower });
    expect(await loanExists(borrower)).toBe(false);
  });

  it('fails_with_the_token_error_when_the_borrower_no_longer_holds_the_principal', async () => {
    const borrower = await borrowerWithLoan(2n * TOKEN);
    const stranger = await newBorrower(f);
    await transferTokens(f.h, borrower.signer, borrower.token, f.mint, stranger.token, 1n);
    const failure = await repayFailure(f, { pool, borrower });
    expectError(failure, SPL_TOKEN_INSUFFICIENT_FUNDS);
    expect(await loanExists(borrower)).toBe(true);
    await transferTokens(f.h, stranger.signer, stranger.token, f.mint, borrower.token, 1n);
    await repay(f, { pool, borrower });
    expect(await loanExists(borrower)).toBe(false);
  });

  it('fails_with_token_owner_error_for_another_wallets_token_account', async () => {
    const borrower = await borrowerWithLoan();
    const stranger = await newBorrower(f);
    const failure = await repayFailure(f, {
      pool,
      borrower,
      accounts: { borrowerToken: stranger.token },
    });
    expectError(failure, ANCHOR_CONSTRAINT_TOKEN_OWNER);
  });

  it('fails_with_token_mint_error_for_a_token_account_of_another_mint', async () => {
    const borrower = await borrowerWithLoan();
    const otherMint = await createMint(f.h, f.mintAuthority.address);
    const wrongToken = await createAta(f.h, borrower.signer, borrower.signer.address, otherMint);
    const failure = await repayFailure(f, {
      pool,
      borrower,
      accounts: { borrowerToken: wrongToken },
    });
    expectError(failure, ANCHOR_CONSTRAINT_TOKEN_MINT);
  });

  it('fails_with_seeds_error_for_the_vault_of_another_pool', async () => {
    const borrower = await borrowerWithLoan();
    const elsewhere = await fundedPool(f);
    const failure = await repayFailure(f, {
      pool,
      borrower,
      accounts: { vault: elsewhere.vault },
    });
    expectError(failure, ANCHOR_CONSTRAINT_SEEDS);
  });

  it('fails_with_not_signer_when_the_borrower_does_not_sign', async () => {
    const borrower = await borrowerWithLoan();
    const failure = await repayFailure(f, {
      pool,
      borrower,
      feePayer: f.h.payer,
      borrowerSigns: false,
    });
    expectError(failure, ANCHOR_ACCOUNT_NOT_SIGNER);
    expect(await loanExists(borrower)).toBe(true);
  });
});
