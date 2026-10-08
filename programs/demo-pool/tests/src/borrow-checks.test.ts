// One negative test per row of the `borrow` check table (plan, "borrow check
// order"), one test per neighbouring pair that breaks both and asserts the
// earlier error, and the Anchor-before-handler cases. Every group proves the
// untouched input passes first.
import { type Address, generateKeyPairSigner } from '@solana/kit';
import {
  DEMO_POOL_ERROR__AMOUNT_OVER_TIER_LIMIT,
  DEMO_POOL_ERROR__ATTESTATION_EXPIRED,
  DEMO_POOL_ERROR__ATTESTATION_TOO_OLD,
  DEMO_POOL_ERROR__ENCLAVE_ENTRY_MISMATCH,
  DEMO_POOL_ERROR__ENCLAVE_REVOKED,
  DEMO_POOL_ERROR__INVALID_ATTESTATION,
  DEMO_POOL_ERROR__MEASUREMENT_NOT_APPROVED,
  DEMO_POOL_ERROR__POLICY_MISMATCH,
  DEMO_POOL_ERROR__TIER_NOT_ACCEPTED,
  DEMO_POOL_ERROR__WINDOW_TOO_OLD,
  DEMO_POOL_ERROR__WINDOW_TOO_SHORT,
  DEMO_POOL_ERROR__WRONG_ATTESTATION_SIGNER,
  DEMO_POOL_ERROR__ZERO_AMOUNT,
  fetchLoan,
  fetchMaybeLoan,
} from '@tio/demo-pool-client';
import { ORACLE_PROGRAM_ADDRESS, findConfigPda } from '@tio/oracle-client';
import {
  ATTESTATION_TTL_SECS,
  SAS_ATTESTATION_LEN,
  SYSTEM_PROGRAM,
  attestationAddress,
  timeTravel,
} from '@tio/oracle-tests/attest';
import { revokeEntry } from '@tio/oracle-tests/attest-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANCHOR_ACCOUNT_NOT_INITIALIZED,
  ANCHOR_ACCOUNT_NOT_SIGNER,
  ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM,
  ANCHOR_CONSTRAINT_HAS_ONE,
  ANCHOR_CONSTRAINT_SEEDS,
  ANCHOR_CONSTRAINT_TOKEN_MINT,
  ANCHOR_CONSTRAINT_TOKEN_OWNER,
  ANCHOR_DISCRIMINATOR_MISMATCH,
  SPL_TOKEN_INSUFFICIENT_FUNDS,
  SYSTEM_ACCOUNT_ALREADY_IN_USE,
  expectError,
} from './assertions.ts';
import {
  DAY,
  type AttestOptions,
  type Borrower,
  type BorrowOpts,
  type CreatePoolOpts,
  type Enclave,
  type PoolFixture,
  type PoolRef,
  SAS_OFFSET,
  approve,
  borrow,
  borrowFailure,
  createPool,
  entryAddress,
  fundVault,
  fundedPool,
  getU32,
  loanAddress,
  newBorrower,
  newEnclave,
  plantAttestation,
  plantAttestationBytes,
  prepare,
  setI64,
  setU32,
  startPoolFixture,
} from './pool-fixture.ts';
import { createAta, createMint, tokenBalance } from './token.ts';

// SPL Token `InsufficientFunds`.

const TOKEN = 1_000_000n;
const A = 1;
const B = 2;
const C = 3;
const MAX_AGE = 3_600;
const MAX_WINDOW_AGE = 30 * DAY;
const MIN_WINDOW = 180 * DAY;
const U64_MAX = 18_446_744_073_709_551_615n;

describe('borrow: checks', () => {
  let f: PoolFixture;
  let pool: PoolRef;
  /** A second registered enclave: the "entry of another id". */
  let other: Enclave;

  beforeAll(async () => {
    f = await startPoolFixture();
    pool = await fundedPool(f);
    other = await newEnclave(f);
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  /** The borrow fails with `code` and leaves no loan behind. */
  async function expectRejected(o: BorrowOpts, code: number, instructionIndex?: number) {
    expectError(await borrowFailure(f, o), code, instructionIndex);
    expect((await fetchMaybeLoan(f.h.rpc, await loanAddress(o.pool, o.borrower))).exists).toBe(
      false,
    );
  }

  /** The borrow succeeds and the borrower holds exactly `amount` more tokens. */
  async function expectBaselineSucceeds(o: BorrowOpts) {
    const before = await tokenBalance(f.h, o.borrower.token);
    await borrow(f, o);
    expect(await tokenBalance(f.h, o.borrower.token)).toBe(before + o.amount);
  }

  /** A borrower whose real attestation was re-planted with `edit` applied (owner SAS by default). */
  async function planted(edit: (data: Uint8Array) => void, owner?: Address): Promise<BorrowOpts> {
    const borrower = await prepare(f);
    await plantAttestation(f, borrower.signer.address, edit, owner);
    return simple(borrower);
  }

  /** The default borrow of one token from the shared pool. */
  function simple(borrower: Borrower): BorrowOpts {
    return { pool, borrower, amount: TOKEN };
  }

  function lender(params: CreatePoolOpts): Promise<PoolRef> {
    return fundedPool(f, params);
  }

  describe('baseline and rule 1: amount > 0 (6002)', () => {
    it('baseline_a_valid_attestation_borrows', async () => {
      await expectBaselineSucceeds({ pool, borrower: await prepare(f), amount: TOKEN });
    });

    it('baseline_the_replanted_untouched_attestation_borrows', async () => {
      const borrower = await prepare(f);
      await plantAttestation(f, borrower.signer.address, () => undefined);
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });

    it('borrow_fails_when_the_amount_is_zero', async () => {
      await expectRejected(
        { pool, borrower: await prepare(f), amount: 0n },
        DEMO_POOL_ERROR__ZERO_AMOUNT,
      );
    });
  });

  describe('rule 2: stored attestation shape (6003)', () => {
    const INVALID = DEMO_POOL_ERROR__INVALID_ATTESTATION;

    it('borrow_fails_when_the_wallet_has_no_attestation', async () => {
      await expectRejected(simple(await newBorrower(f)), INVALID);
    });

    it('borrow_fails_when_the_attestation_is_owned_by_the_oracle_program', async () => {
      await expectRejected(await planted(() => undefined, ORACLE_PROGRAM_ADDRESS), INVALID);
    });

    it('borrow_fails_when_the_attestation_is_owned_by_the_system_program', async () => {
      await expectRejected(await planted(() => undefined, SYSTEM_PROGRAM), INVALID);
    });

    it('borrow_fails_when_the_attestation_is_255_bytes', async () => {
      const borrower = await prepare(f);
      await plantAttestationBytes(f, borrower.signer.address, (d) => d.slice(0, 255));
      await expectRejected(simple(borrower), INVALID);
    });

    it('borrow_fails_when_the_attestation_is_257_bytes', async () => {
      const borrower = await prepare(f);
      await plantAttestationBytes(f, borrower.signer.address, (d) => {
        const longer = new Uint8Array(SAS_ATTESTATION_LEN + 1);
        longer.set(d);
        return longer;
      });
      await expectRejected(simple(borrower), INVALID);
    });

    it('borrow_fails_when_the_discriminator_is_1', async () => {
      const opts = await planted((d) => {
        d[SAS_OFFSET.discriminator] = 1;
      });
      await expectRejected(opts, INVALID);
    });

    it('borrow_fails_when_the_discriminator_is_0', async () => {
      const opts = await planted((d) => {
        d[SAS_OFFSET.discriminator] = 0;
      });
      await expectRejected(opts, INVALID);
    });
  });

  describe('rule 3: stored signer is the oracle sas_signer (6004)', () => {
    const WRONG_SIGNER = DEMO_POOL_ERROR__WRONG_ATTESTATION_SIGNER;

    it('borrow_fails_when_the_signer_is_another_address', async () => {
      const opts = await planted((d) => d.fill(0x07, SAS_OFFSET.signer, SAS_OFFSET.signer + 32));
      await expectRejected(opts, WRONG_SIGNER);
    });

    it('borrow_fails_when_the_signer_is_all_zero', async () => {
      const opts = await planted((d) => d.fill(0, SAS_OFFSET.signer, SAS_OFFSET.signer + 32));
      await expectRejected(opts, WRONG_SIGNER);
    });

    it('borrow_fails_when_only_the_last_signer_byte_differs', async () => {
      const opts = await planted((d) => {
        d[SAS_OFFSET.signer + 31] = (d[SAS_OFFSET.signer + 31] ?? 0) ^ 1;
      });
      await expectRejected(opts, WRONG_SIGNER);
    });

    it('borrow_fails_when_only_the_first_signer_byte_differs', async () => {
      const opts = await planted((d) => {
        d[SAS_OFFSET.signer] = (d[SAS_OFFSET.signer] ?? 0) ^ 1;
      });
      await expectRejected(opts, WRONG_SIGNER);
    });
  });

  describe('rule 4: now < expiry (6005)', () => {
    // Expiry is issued_at + 30 d; the pool must accept attestations that old.
    let longLived: PoolRef;

    beforeAll(async () => {
      longLived = await lender({ params: { maxAgeSecs: 40 * DAY } });
    });

    it('borrow_succeeds_one_second_before_the_expiry', async () => {
      const borrower = await prepare(f);
      await timeTravel(f.h, borrower.now + ATTESTATION_TTL_SECS - 1n);
      await expectBaselineSucceeds({ pool: longLived, borrower, amount: TOKEN });
    });

    it('borrow_fails_exactly_at_the_expiry', async () => {
      const borrower = await prepare(f);
      await timeTravel(f.h, borrower.now + ATTESTATION_TTL_SECS);
      await expectRejected(
        { pool: longLived, borrower, amount: TOKEN },
        DEMO_POOL_ERROR__ATTESTATION_EXPIRED,
      );
    });

    it('borrow_fails_one_second_after_the_expiry', async () => {
      const borrower = await prepare(f);
      await timeTravel(f.h, borrower.now + ATTESTATION_TTL_SECS + 1n);
      await expectRejected(
        { pool: longLived, borrower, amount: TOKEN },
        DEMO_POOL_ERROR__ATTESTATION_EXPIRED,
      );
    });

    it('borrow_fails_when_the_stored_expiry_is_zero', async () => {
      const borrower = await prepare(f);
      await plantAttestation(f, borrower.signer.address, (d) => setI64(d, SAS_OFFSET.expiry, 0n));
      await expectRejected(
        { pool: longLived, borrower, amount: TOKEN },
        DEMO_POOL_ERROR__ATTESTATION_EXPIRED,
      );
    });

    it('borrow_fails_when_the_stored_expiry_equals_now', async () => {
      const borrower = await prepare(f);
      await plantAttestation(f, borrower.signer.address, (d) =>
        setI64(d, SAS_OFFSET.expiry, borrower.now),
      );
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__ATTESTATION_EXPIRED);
    });

    it('borrow_succeeds_when_the_stored_expiry_is_one_second_after_now', async () => {
      const borrower = await prepare(f);
      await plantAttestation(f, borrower.signer.address, (d) =>
        setI64(d, SAS_OFFSET.expiry, borrower.now + 1n),
      );
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });
  });

  describe('rule 5: tier accepted (6006)', () => {
    let noTierC: PoolRef;

    beforeAll(async () => {
      noTierC = await lender({ params: { tierLimits: [3n * TOKEN, 2n * TOKEN, 0n] } });
    });

    it('baseline_a_pool_with_a_zero_tier_c_limit_still_lends_to_tier_b', async () => {
      await expectBaselineSucceeds({
        pool: noTierC,
        borrower: await prepare(f, { tier: B }),
        amount: TOKEN,
      });
    });

    it('borrow_fails_when_the_tier_limit_is_zero', async () => {
      await expectRejected(
        { pool: noTierC, borrower: await prepare(f, { tier: C }), amount: TOKEN },
        DEMO_POOL_ERROR__TIER_NOT_ACCEPTED,
      );
    });

    it.each([0, 4, 9])('borrow_fails_when_the_stored_tier_is_%i', async (tier) => {
      const borrower = await prepare(f);
      await plantAttestation(f, borrower.signer.address, (d) => {
        d[SAS_OFFSET.tier] = tier;
      });
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__TIER_NOT_ACCEPTED);
    });
  });

  describe('rule 6: amount <= tier limit (6007)', () => {
    describe.each([
      ['a', A, 3n * TOKEN],
      ['b', B, 2n * TOKEN],
      ['c', C, TOKEN],
    ])('tier %s', (_name, tier, limit) => {
      it('borrow_succeeds_at_the_limit', async () => {
        const borrower = await prepare(f, { tier });
        await expectBaselineSucceeds({ pool, borrower, amount: limit });
      });

      it('borrow_fails_one_base_unit_over_the_limit', async () => {
        const borrower = await prepare(f, { tier });
        await expectRejected(
          { pool, borrower, amount: limit + 1n },
          DEMO_POOL_ERROR__AMOUNT_OVER_TIER_LIMIT,
        );
      });
    });

    it('borrow_fails_for_the_largest_u64_amount', async () => {
      const borrower = await prepare(f);
      await expectRejected(
        { pool, borrower, amount: U64_MAX },
        DEMO_POOL_ERROR__AMOUNT_OVER_TIER_LIMIT,
      );
    });
  });

  describe('rule 7: policy hash (6008)', () => {
    it('baseline_the_same_policy_hash_borrows', async () => {
      await expectBaselineSucceeds({ pool, borrower: await prepare(f), amount: TOKEN });
    });

    it.each([0, 31])('borrow_fails_when_only_policy_hash_byte_%i_differs', async (index) => {
      const policyHash = new Uint8Array(32).fill(0x11);
      policyHash[index] = 0x12;
      const borrower = await prepare(f, { policyHash });
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__POLICY_MISMATCH);
    });
  });

  describe('rule 8: now - issued_at <= max_age_secs (6009)', () => {
    it('borrow_succeeds_when_the_age_equals_the_limit', async () => {
      const borrower = await prepare(f);
      await timeTravel(f.h, borrower.now + BigInt(MAX_AGE));
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });

    it('borrow_fails_one_second_past_the_age_limit', async () => {
      const borrower = await prepare(f);
      await timeTravel(f.h, borrower.now + BigInt(MAX_AGE) + 1n);
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__ATTESTATION_TOO_OLD);
    });
  });

  describe('rule 9: issued_at - window_to <= max_window_age_secs (6010)', () => {
    it('borrow_succeeds_when_the_window_age_equals_the_limit', async () => {
      const borrower = await prepare(f, windowAt(MAX_WINDOW_AGE, MIN_WINDOW));
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });

    it('borrow_fails_one_second_past_the_window_age_limit', async () => {
      const borrower = await prepare(f, windowAt(MAX_WINDOW_AGE + 1, MIN_WINDOW));
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__WINDOW_TOO_OLD);
    });
  });

  describe('rule 10: window_to - window_from >= min_window_secs (6011)', () => {
    it('borrow_succeeds_when_the_window_length_equals_the_limit', async () => {
      const borrower = await prepare(f, windowAt(DAY, MIN_WINDOW));
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });

    it('borrow_fails_when_the_window_is_one_second_too_short', async () => {
      const borrower = await prepare(f, windowAt(DAY, MIN_WINDOW - 1));
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__WINDOW_TOO_SHORT);
    });

    it('borrow_fails_when_window_to_is_before_window_from', async () => {
      const borrower = await prepare(f);
      await plantAttestation(f, borrower.signer.address, (d) =>
        setU32(d, SAS_OFFSET.windowFrom, getU32(d, SAS_OFFSET.windowTo) + 1_000),
      );
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__WINDOW_TOO_SHORT);
    });
  });

  describe('rule 11: measurement approved (6012)', () => {
    it('borrow_fails_when_the_bitmap_bit_of_the_enclave_is_clear', async () => {
      const closed = await lender({ params: { approvedMeasurements: approve() } });
      const borrower = await prepare(f);
      await expectRejected(
        { pool: closed, borrower, amount: TOKEN },
        DEMO_POOL_ERROR__MEASUREMENT_NOT_APPROVED,
      );
    });

    it('borrow_fails_when_only_a_neighbouring_bit_is_set', async () => {
      const neighbour = await lender({
        params: { approvedMeasurements: approve(f.entryId + 1, f.entryId + 8) },
      });
      await expectRejected(
        { pool: neighbour, borrower: await prepare(f), amount: TOKEN },
        DEMO_POOL_ERROR__MEASUREMENT_NOT_APPROVED,
      );
    });

    it('borrow_succeeds_only_for_the_enclave_whose_bit_in_a_later_byte_is_set', async () => {
      const enclaves: Enclave[] = [];
      for (let i = 0; i < 10; i += 1) {
        enclaves.push(await newEnclave(f));
      }
      const first = enclaves[0];
      const last = enclaves[9];
      if (first === undefined || last === undefined) throw new Error('enclaves missing');
      const picky = await lender({ params: { approvedMeasurements: approve(last.entryId) } });
      const rejected = await prepare(f, { enclave: first });
      await expectRejected(
        { pool: picky, borrower: rejected, amount: TOKEN },
        DEMO_POOL_ERROR__MEASUREMENT_NOT_APPROVED,
      );
      const accepted = await prepare(f, { enclave: last });
      await expectBaselineSucceeds({ pool: picky, borrower: accepted, amount: TOKEN });
    });
  });

  describe('rule 12: enclave entry matches the attested measurement (6013)', () => {
    it('borrow_fails_when_the_entry_belongs_to_another_registered_id', async () => {
      const borrower = await prepare(f);
      await expectRejected(
        {
          pool,
          borrower,
          amount: TOKEN,
          accounts: { enclaveEntry: await entryAddress(other.entryId) },
        },
        DEMO_POOL_ERROR__ENCLAVE_ENTRY_MISMATCH,
      );
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });
  });

  describe('rule 13: enclave not revoked (6014)', () => {
    it('borrow_fails_when_the_enclave_was_revoked_after_the_attestation_was_issued', async () => {
      const doomed = await newEnclave(f);
      // Each `prepare` moves the clock 10 000 s; a long max age keeps both
      // attestations fresh, so only the revoke can reject the second borrow.
      const approving = await lender({
        params: { approvedMeasurements: approve(f.entryId, doomed.entryId), maxAgeSecs: DAY },
      });
      const before = await prepare(f, { enclave: doomed });
      const after = await prepare(f, { enclave: doomed });
      await expectBaselineSucceeds({ pool: approving, borrower: before, amount: TOKEN });
      await revokeEntry(f.h, doomed.entryId);
      await expectRejected(
        { pool: approving, borrower: after, amount: TOKEN },
        DEMO_POOL_ERROR__ENCLAVE_REVOKED,
      );
    });
  });

  // Each test breaks a check and the one after it; the earlier error must win.
  describe('check order: neighbouring pairs', () => {
    it('reports_1_zero_amount_before_2_missing_attestation', async () => {
      const borrower = await newBorrower(f);
      await expectRejected({ pool, borrower, amount: 0n }, DEMO_POOL_ERROR__ZERO_AMOUNT);
    });

    it('reports_2_invalid_attestation_before_3_wrong_signer', async () => {
      const borrower = await prepare(f);
      await plantAttestation(f, borrower.signer.address, (d) => {
        d[SAS_OFFSET.discriminator] = 1;
        d.fill(0x07, SAS_OFFSET.signer, SAS_OFFSET.signer + 32);
      });
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__INVALID_ATTESTATION);
    });

    it('reports_3_wrong_signer_before_4_expired', async () => {
      const borrower = await prepare(f);
      await plantAttestation(f, borrower.signer.address, (d) => {
        d.fill(0x07, SAS_OFFSET.signer, SAS_OFFSET.signer + 32);
        setI64(d, SAS_OFFSET.expiry, 0n);
      });
      await expectRejected(
        { pool, borrower, amount: TOKEN },
        DEMO_POOL_ERROR__WRONG_ATTESTATION_SIGNER,
      );
    });

    it('reports_4_expired_before_5_tier_not_accepted', async () => {
      const borrower = await prepare(f);
      await plantAttestation(f, borrower.signer.address, (d) => {
        setI64(d, SAS_OFFSET.expiry, 0n);
        d[SAS_OFFSET.tier] = 9;
      });
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__ATTESTATION_EXPIRED);
    });

    it('reports_4_expired_before_5_tier_not_accepted_for_a_zero_tier_limit', async () => {
      const noTierC = await lender({ params: { tierLimits: [3n * TOKEN, 2n * TOKEN, 0n] } });
      const borrower = await prepare(f, { tier: C });
      await timeTravel(f.h, borrower.now + ATTESTATION_TTL_SECS);
      await expectRejected(
        { pool: noTierC, borrower, amount: TOKEN },
        DEMO_POOL_ERROR__ATTESTATION_EXPIRED,
      );
    });

    it('reports_5_tier_not_accepted_before_6_amount_over_limit', async () => {
      const noTierC = await lender({ params: { tierLimits: [3n * TOKEN, 2n * TOKEN, 0n] } });
      const borrower = await prepare(f, { tier: C });
      await expectRejected(
        { pool: noTierC, borrower, amount: TOKEN },
        DEMO_POOL_ERROR__TIER_NOT_ACCEPTED,
      );
    });

    it('reports_6_amount_over_limit_before_7_policy_mismatch', async () => {
      const borrower = await prepare(f, { policyHash: new Uint8Array(32).fill(0x33) });
      await expectRejected(
        { pool, borrower, amount: 3n * TOKEN + 1n },
        DEMO_POOL_ERROR__AMOUNT_OVER_TIER_LIMIT,
      );
    });

    it('reports_7_policy_mismatch_before_8_too_old', async () => {
      const borrower = await prepare(f, { policyHash: new Uint8Array(32).fill(0x33) });
      await timeTravel(f.h, borrower.now + BigInt(MAX_AGE) + 1n);
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__POLICY_MISMATCH);
    });

    it('reports_8_too_old_before_9_window_too_old', async () => {
      const borrower = await prepare(f, windowAt(MAX_WINDOW_AGE + 1, MIN_WINDOW));
      await timeTravel(f.h, borrower.now + BigInt(MAX_AGE) + 1n);
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__ATTESTATION_TOO_OLD);
    });

    it('reports_9_window_too_old_before_10_window_too_short', async () => {
      const borrower = await prepare(f, windowAt(MAX_WINDOW_AGE + 1, 10));
      await expectRejected({ pool, borrower, amount: TOKEN }, DEMO_POOL_ERROR__WINDOW_TOO_OLD);
    });

    it('reports_10_window_too_short_before_11_not_approved', async () => {
      const closed = await lender({ params: { approvedMeasurements: approve() } });
      const borrower = await prepare(f, windowAt(DAY, 10));
      await expectRejected(
        { pool: closed, borrower, amount: TOKEN },
        DEMO_POOL_ERROR__WINDOW_TOO_SHORT,
      );
    });

    it('reports_11_not_approved_before_12_entry_mismatch', async () => {
      const closed = await lender({ params: { approvedMeasurements: approve() } });
      const borrower = await prepare(f);
      await expectRejected(
        {
          pool: closed,
          borrower,
          amount: TOKEN,
          accounts: { enclaveEntry: await entryAddress(other.entryId) },
        },
        DEMO_POOL_ERROR__MEASUREMENT_NOT_APPROVED,
      );
    });

    it('reports_12_entry_mismatch_before_13_revoked', async () => {
      const revoked = await newEnclave(f);
      await revokeEntry(f.h, revoked.entryId);
      const borrower = await prepare(f);
      await expectRejected(
        {
          pool,
          borrower,
          amount: TOKEN,
          accounts: { enclaveEntry: await entryAddress(revoked.entryId) },
        },
        DEMO_POOL_ERROR__ENCLAVE_ENTRY_MISMATCH,
      );
    });
  });

  describe('Anchor constraints: wrong accounts', () => {
    it('borrow_fails_with_seeds_error_for_another_wallets_attestation', async () => {
      // Prepared in this order: each `prepare` moves the clock, and the
      // borrower's attestation must still be fresh for the baseline.
      const stranger = await prepare(f);
      const borrower = await prepare(f);
      const theirs = await attestationAddress(f.credential, f.schema, stranger.signer.address);
      await expectRejected(
        { pool, borrower, amount: TOKEN, accounts: { attestation: theirs } },
        ANCHOR_CONSTRAINT_SEEDS,
      );
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });

    it('borrow_fails_with_seeds_error_for_a_random_attestation_address', async () => {
      const borrower = await prepare(f);
      const random = (await generateKeyPairSigner()).address;
      await expectRejected(
        { pool, borrower, amount: TOKEN, accounts: { attestation: random } },
        ANCHOR_CONSTRAINT_SEEDS,
      );
    });

    it('borrow_fails_with_seeds_error_when_the_pool_credential_differs_from_the_attestations', async () => {
      const elsewhere = await lender({ credential: (await generateKeyPairSigner()).address });
      const borrower = await prepare(f);
      const real = await attestationAddress(f.credential, f.schema, borrower.signer.address);
      await expectRejected(
        { pool: elsewhere, borrower, amount: TOKEN, accounts: { attestation: real } },
        ANCHOR_CONSTRAINT_SEEDS,
      );
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });

    it('borrow_fails_with_seeds_error_when_the_pool_schema_differs_from_the_attestations', async () => {
      const elsewhere = await lender({ schema: (await generateKeyPairSigner()).address });
      const borrower = await prepare(f);
      const real = await attestationAddress(f.credential, f.schema, borrower.signer.address);
      await expectRejected(
        { pool: elsewhere, borrower, amount: TOKEN, accounts: { attestation: real } },
        ANCHOR_CONSTRAINT_SEEDS,
      );
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });

    it('borrow_fails_with_not_signer_when_the_borrower_does_not_sign', async () => {
      const borrower = await prepare(f);
      await expectRejected(
        { pool, borrower, amount: TOKEN, payer: f.relayer, borrowerSigns: false },
        ANCHOR_ACCOUNT_NOT_SIGNER,
      );
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN, payer: f.relayer });
    });

    it('borrow_fails_with_token_owner_error_for_another_wallets_token_account', async () => {
      const borrower = await prepare(f);
      const stranger = await newBorrower(f);
      await expectRejected(
        { pool, borrower, amount: TOKEN, accounts: { borrowerToken: stranger.token } },
        ANCHOR_CONSTRAINT_TOKEN_OWNER,
      );
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });

    it('borrow_fails_with_token_mint_error_for_a_token_account_of_another_mint', async () => {
      const borrower = await prepare(f);
      const otherMint = await createMint(f.h, f.mintAuthority.address);
      const wrongToken = await createAta(f.h, borrower.signer, borrower.signer.address, otherMint);
      await expectRejected(
        { pool, borrower, amount: TOKEN, accounts: { borrowerToken: wrongToken } },
        ANCHOR_CONSTRAINT_TOKEN_MINT,
      );
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });

    it('borrow_fails_with_has_one_error_when_the_mint_is_not_the_pool_mint', async () => {
      const borrower = await prepare(f);
      const otherMint = await createMint(f.h, f.mintAuthority.address);
      await expectRejected(
        { pool, borrower, amount: TOKEN, accounts: { mint: otherMint } },
        ANCHOR_CONSTRAINT_HAS_ONE,
      );
    });

    it('borrow_fails_with_seeds_error_for_the_vault_of_another_pool', async () => {
      const borrower = await prepare(f);
      const elsewhere = await lender({});
      await expectRejected(
        { pool, borrower, amount: TOKEN, accounts: { vault: elsewhere.vault } },
        ANCHOR_CONSTRAINT_SEEDS,
      );
    });

    it('borrow_fails_with_seeds_error_for_another_borrowers_loan_address', async () => {
      // Prepared in this order: each `prepare` moves the clock, and the
      // borrower's attestation must still be fresh for the baseline.
      const stranger = await prepare(f);
      const borrower = await prepare(f);
      await expectRejected(
        {
          pool,
          borrower,
          amount: TOKEN,
          accounts: { loan: await loanAddress(pool, stranger) },
        },
        ANCHOR_CONSTRAINT_SEEDS,
      );
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
    });

    it('borrow_fails_with_not_initialized_when_the_enclave_entry_does_not_exist', async () => {
      const borrower = await prepare(f);
      const missing = (await generateKeyPairSigner()).address;
      await expectRejected(
        { pool, borrower, amount: TOKEN, accounts: { enclaveEntry: missing } },
        ANCHOR_ACCOUNT_NOT_INITIALIZED,
      );
    });

    it('borrow_fails_with_wrong_owner_when_the_enclave_entry_is_not_an_oracle_account', async () => {
      const borrower = await prepare(f);
      await expectRejected(
        { pool, borrower, amount: TOKEN, accounts: { enclaveEntry: pool.admin.address } },
        ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM,
      );
    });

    it('borrow_fails_with_discriminator_mismatch_when_the_enclave_entry_is_the_oracle_config', async () => {
      const borrower = await prepare(f);
      const [config] = await findConfigPda();
      await expectRejected(
        { pool, borrower, amount: TOKEN, accounts: { enclaveEntry: config } },
        ANCHOR_DISCRIMINATOR_MISMATCH,
      );
    });
  });

  describe('Anchor before the handler', () => {
    it('reports_the_seeds_error_before_a_zero_amount', async () => {
      const borrower = await prepare(f);
      const stranger = await prepare(f);
      const theirs = await attestationAddress(f.credential, f.schema, stranger.signer.address);
      await expectRejected(
        { pool, borrower, amount: 0n, accounts: { attestation: theirs } },
        ANCHOR_CONSTRAINT_SEEDS,
      );
    });

    it('reports_already_in_use_before_a_zero_amount_when_a_loan_is_open', async () => {
      const borrower = await prepare(f);
      await borrow(f, { pool, borrower, amount: TOKEN });
      const failure = await borrowFailure(f, { pool, borrower, amount: 0n });
      expectError(failure, SYSTEM_ACCOUNT_ALREADY_IN_USE);
    });
  });

  describe('loan account and vault', () => {
    it('borrow_fails_with_already_in_use_while_a_loan_is_open', async () => {
      const borrower = await prepare(f);
      await borrow(f, { pool, borrower, amount: TOKEN });
      const failure = await borrowFailure(f, { pool, borrower, amount: TOKEN });
      expectError(failure, SYSTEM_ACCOUNT_ALREADY_IN_USE);
      expect((await fetchLoan(f.h.rpc, await loanAddress(pool, borrower))).data.amount).toBe(TOKEN);
      expect(await tokenBalance(f.h, borrower.token)).toBe(TOKEN);
    });

    it('borrow_fails_with_the_token_error_when_the_vault_is_short', async () => {
      const dry = await createPool(f);
      await fundVault(f, dry, 3n * TOKEN - 1n);
      const borrower = await prepare(f);
      await expectRejected(
        { pool: dry, borrower, amount: 3n * TOKEN },
        SPL_TOKEN_INSUFFICIENT_FUNDS,
      );
      await fundVault(f, dry, 1n);
      await expectBaselineSucceeds({ pool: dry, borrower, amount: 3n * TOKEN });
    });

    it.each([
      ['below_rent', 1],
      ['above_rent', 10_000_000],
    ])('borrow_creates_the_loan_when_its_address_is_pre_funded_%s', async (_name, lamports) => {
      const borrower = await prepare(f);
      const address = await loanAddress(pool, borrower);
      f.h.surfnet.fundSol(address, lamports);
      await expectBaselineSucceeds({ pool, borrower, amount: TOKEN });
      const loan = (await fetchLoan(f.h.rpc, address)).data;
      expect(loan).toMatchObject({
        version: 1,
        tier: A,
        pool: pool.address,
        borrower: borrower.signer.address,
        rentPayer: borrower.signer.address,
        amount: TOKEN,
        borrowedAt: borrower.now,
        attestationIssuedAt: borrower.now,
      });
    });
  });
});

/** `prepare` options for a statement that ended `ageSecs` before issue and is `lengthSecs` long. */
function windowAt(ageSecs: number, lengthSecs: number): AttestOptions {
  return { window: { ageSecs, lengthSecs } };
}
