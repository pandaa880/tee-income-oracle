import { type Address, type Instruction, generateKeyPairSigner } from '@solana/kit';
import {
  ORACLE_ERROR__ATTESTATION_ADDRESS_MISMATCH,
  ORACLE_ERROR__ATTESTER_MISMATCH,
  ORACLE_ERROR__CREDENTIAL_MISMATCH,
  ORACLE_ERROR__ENCLAVE_ENTRY_MISMATCH,
  ORACLE_ERROR__ENCLAVE_REVOKED,
  ORACLE_ERROR__EXPIRY_TOO_FAR,
  ORACLE_ERROR__INVALID_PRECOMPILE_LAYOUT,
  ORACLE_ERROR__INVALID_TIER,
  ORACLE_ERROR__ISSUED_IN_FUTURE,
  ORACLE_ERROR__PRECOMPILE_NOT_FOUND,
  ORACLE_ERROR__PROOF_TYPE_MISMATCH,
  ORACLE_ERROR__SCHEMA_MISMATCH,
  ORACLE_ERROR__SIGNATURE_EXPIRED,
  ORACLE_ERROR__STALE_ATTESTATION,
  ORACLE_ERROR__WRONG_DOMAIN_TAG,
  ORACLE_ERROR__WRONG_PROGRAM_ID,
} from '@tio/oracle-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_SKEW_SECS,
  type SubmitParams,
  attestationAddress,
  buildPrecompileData,
  buildShiftedPrecompileData,
  buildTwoSignaturePrecompileData,
  precompileInstruction,
  timeTravel,
} from './attest.ts';
import {
  type Case,
  type Fixture,
  attestationExists,
  freshKey,
  instructionsFor,
  newCase,
  registerKey,
  revokeEntry,
  sendExpectingFailure,
  startFixture,
  submit,
  submitExpectingFailure,
} from './attest-fixture.ts';
import { KIND_AWS_PCR0, findCustomErrorCode, send } from './harness.ts';

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111' as Address;

/** SetComputeUnitPrice(0): a harmless instruction that is not the precompile. */
function computePriceIx(): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  return { programAddress: COMPUTE_BUDGET, data };
}

async function stranger(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}
function flipFirstTagByte(m: Uint8Array): void {
  m[0] = (m[0] ?? 0) ^ 1;
}

const trailingByte: SubmitParams['buildData'] = (key, message, index) => {
  const data = buildPrecompileData(key, message, index);
  const padded = new Uint8Array(data.length + 1);
  padded.set(data);
  return padded;
};

describe('submit_attestation: precompile introspection (6011, 6012)', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await startFixture();
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  async function expectRejected(c: Case, code: number) {
    const failure = await submitExpectingFailure(f, c.params);
    expect(failure.code).toBe(code);
    expect(await attestationExists(f, c.wallet)).toBe(false);
  }

  async function expectBaselineSucceeds() {
    const c = await newCase(f);
    await submit(f, c.params);
    expect(await attestationExists(f, c.wallet)).toBe(true);
  }

  it('baseline_precompile_directly_before_the_oracle_instruction_succeeds', async () => {
    await expectBaselineSucceeds();
  });

  it('rejects_with_6011_when_the_previous_instruction_is_not_a_precompile', async () => {
    const c = await newCase(f);
    const s = await instructionsFor(f, c.params);
    const failure = await sendExpectingFailure(f, f.relayer, [s.oracle]);
    expect(failure.code).toBe(ORACLE_ERROR__PRECOMPILE_NOT_FOUND);
    expect(await attestationExists(f, c.wallet)).toBe(false);
  });

  it('rejects_with_6011_when_the_oracle_instruction_is_the_first_in_the_transaction', async () => {
    const c = await newCase(f);
    const s = await instructionsFor(f, c.params);
    const failure = await send(f.h, f.relayer, [s.oracle], { bare: true }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    expect(findCustomErrorCode(failure)).toBe(ORACLE_ERROR__PRECOMPILE_NOT_FOUND);
  });

  it('rejects_with_6011_when_another_instruction_sits_between_precompile_and_oracle', async () => {
    const c = await newCase(f);
    const s = await instructionsFor(f, c.params);
    const failure = await sendExpectingFailure(f, f.relayer, [
      s.precompile,
      computePriceIx(),
      s.oracle,
    ]);
    expect(failure.code).toBe(ORACLE_ERROR__PRECOMPILE_NOT_FOUND);
    expect(await attestationExists(f, c.wallet)).toBe(false);
  });

  it('rejects_with_6011_when_the_precompile_comes_after_the_oracle_instruction', async () => {
    // [compute budget (harness), oracle, precompile]: the precompile sits at index 2.
    const c = await newCase(f, { params: { precompileIndex: 2 } });
    const s = await instructionsFor(f, c.params);
    const failure = await sendExpectingFailure(f, f.relayer, [s.oracle, s.precompile]);
    expect(failure.code).toBe(ORACLE_ERROR__PRECOMPILE_NOT_FOUND);
  });

  it('accepts_the_precompile_at_a_later_position_when_it_is_still_adjacent', async () => {
    // [compute budget (harness, index 0), price, precompile, oracle]: precompile at index 2.
    const c = await newCase(f, { params: { precompileIndex: 2 } });
    const s = await instructionsFor(f, c.params);
    await send(f.h, f.relayer, [computePriceIx(), s.precompile, s.oracle]);
    expect(await attestationExists(f, c.wallet)).toBe(true);
  });

  it('rejects_with_6012_when_the_data_has_a_trailing_byte', async () => {
    const c = await newCase(f, {
      params: { buildData: trailingByte },
    });
    await expectRejected(c, ORACLE_ERROR__INVALID_PRECOMPILE_LAYOUT);
  });

  it('rejects_with_6012_when_the_signature_count_is_two', async () => {
    const c = await newCase(f, {
      params: { buildData: buildTwoSignaturePrecompileData },
    });
    await expectRejected(c, ORACLE_ERROR__INVALID_PRECOMPILE_LAYOUT);
  });

  it('rejects_with_6012_when_the_layout_is_shifted_by_one_byte', async () => {
    const c = await newCase(f, {
      params: {
        buildData: (key, message, index) => buildShiftedPrecompileData(key, message, index, 1),
      },
    });
    await expectRejected(c, ORACLE_ERROR__INVALID_PRECOMPILE_LAYOUT);
  });

  // The precompile reads each component from the instruction its index field
  // names. A decoy instruction at index 1 carries the same valid bytes, so the
  // runtime check passes; only the oracle's own index check can catch it.
  async function expectMismatch(field: number) {
    const c = await newCase(f, {
      params: {
        precompileIndex: 2,
        mutateData: (data) => {
          data[field] = 1;
        },
      },
    });
    const s = await instructionsFor(f, c.params);
    const decoy = precompileInstruction(buildPrecompileData(c.params.key, s.message, 1));
    const failure = await sendExpectingFailure(f, f.relayer, [decoy, s.precompile, s.oracle]);
    expect(failure.code).toBe(ORACLE_ERROR__INVALID_PRECOMPILE_LAYOUT);
    expect(await attestationExists(f, c.wallet)).toBe(false);
  }

  it('rejects_with_6012_when_the_signature_index_points_at_another_instruction', async () => {
    await expectMismatch(3);
  });

  it('rejects_with_6012_when_the_eth_address_index_points_at_another_instruction', async () => {
    await expectMismatch(6);
  });

  it('rejects_with_6012_when_the_message_index_points_at_another_instruction', async () => {
    await expectMismatch(11);
  });

  it('rejects_with_6012_a_forged_message_whose_signature_lives_in_a_decoy_instruction', async () => {
    // The attacker signs the forged message with their own key in a decoy
    // instruction, then points all three index fields at it while the
    // precompile instruction itself names the registered enclave's address.
    const attacker = freshKey();
    const c = await newCase(f, {
      params: {
        key: attacker,
        precompileIndex: 2,
        mutateData: (data) => {
          data.set(f.key.ethAddress, 12);
          data[3] = 1;
          data[6] = 1;
          data[11] = 1;
        },
      },
    });
    const s = await instructionsFor(f, c.params);
    const decoy = precompileInstruction(buildPrecompileData(attacker, s.message, 1));
    const failure = await sendExpectingFailure(f, f.relayer, [decoy, s.precompile, s.oracle]);
    expect(failure.code).toBe(ORACLE_ERROR__INVALID_PRECOMPILE_LAYOUT);
    expect(await attestationExists(f, c.wallet)).toBe(false);
  });
});

describe('submit_attestation: message and account binding (6013 to 6018)', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await startFixture();
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  async function expectRejected(c: Case, code: number) {
    const failure = await submitExpectingFailure(f, c.params);
    expect(failure.code).toBe(code);
    expect(await attestationExists(f, c.wallet)).toBe(false);
  }

  it('baseline_consistent_message_and_accounts_succeed', async () => {
    const c = await newCase(f);
    await submit(f, c.params);
    expect(await attestationExists(f, c.wallet)).toBe(true);
  });

  it('rejects_with_6013_when_the_first_tag_byte_is_wrong', async () => {
    const c = await newCase(f, {
      params: {
        mutateMessage: (m) => {
          m[0] = (m[0] ?? 0) ^ 1;
        },
      },
    });
    await expectRejected(c, ORACLE_ERROR__WRONG_DOMAIN_TAG);
  });

  it('rejects_with_6013_when_the_last_tag_byte_is_wrong', async () => {
    const c = await newCase(f, {
      params: {
        mutateMessage: (m) => {
          m[12] = (m[12] ?? 0) ^ 1;
        },
      },
    });
    await expectRejected(c, ORACLE_ERROR__WRONG_DOMAIN_TAG);
  });

  it('rejects_with_6014_when_the_message_names_another_program', async () => {
    const c = await newCase(f, { params: { message: { programId: await stranger() } } });
    await expectRejected(c, ORACLE_ERROR__WRONG_PROGRAM_ID);
  });

  it('rejects_with_6015_when_the_credential_account_differs_from_the_signed_one', async () => {
    const c = await newCase(f, { params: { message: { credential: await stranger() } } });
    await expectRejected(c, ORACLE_ERROR__CREDENTIAL_MISMATCH);
  });

  it('rejects_with_6015_when_the_account_is_swapped_and_the_message_is_right', async () => {
    const c = await newCase(f, { params: { accounts: { credential: await stranger() } } });
    await expectRejected(c, ORACLE_ERROR__CREDENTIAL_MISMATCH);
  });

  it('rejects_with_6016_when_the_schema_account_differs_from_the_signed_one', async () => {
    const c = await newCase(f, { params: { message: { schema: await stranger() } } });
    await expectRejected(c, ORACLE_ERROR__SCHEMA_MISMATCH);
  });

  it('rejects_with_6017_when_the_attestation_account_is_for_another_wallet', async () => {
    const other = await stranger();
    const c = await newCase(f, {
      params: {
        accounts: { attestation: await attestationAddress(f.credential, f.schema, other) },
      },
    });
    await expectRejected(c, ORACLE_ERROR__ATTESTATION_ADDRESS_MISMATCH);
    expect(await attestationExists(f, other)).toBe(false);
  });

  it('rejects_with_6017_when_the_attestation_account_is_a_random_address', async () => {
    const c = await newCase(f, { params: { accounts: { attestation: await stranger() } } });
    await expectRejected(c, ORACLE_ERROR__ATTESTATION_ADDRESS_MISMATCH);
  });

  it('rejects_with_6018_when_the_entry_id_differs_from_the_payload_measurement_id', async () => {
    const otherId = await registerKey(f.h, freshKey());
    // Entry account = f.entryId, payload says otherId.
    const c = await newCase(f, { payload: { measurementId: otherId } });
    await expectRejected(c, ORACLE_ERROR__ENCLAVE_ENTRY_MISMATCH);
  });
});

describe('submit_attestation: registry checks (6019 to 6022)', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await startFixture();
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  async function expectRejected(c: Case, code: number) {
    const failure = await submitExpectingFailure(f, c.params);
    expect(failure.code).toBe(code);
    expect(await attestationExists(f, c.wallet)).toBe(false);
  }

  it('rejects_with_6019_when_the_enclave_entry_is_revoked', async () => {
    const key = freshKey();
    const id = await registerKey(f.h, key);
    const baseline = await newCase(f, { key, entryId: id });
    await submit(f, baseline.params);
    expect(await attestationExists(f, baseline.wallet)).toBe(true);

    await revokeEntry(f.h, id);
    const c = await newCase(f, { key, entryId: id });
    await expectRejected(c, ORACLE_ERROR__ENCLAVE_REVOKED);
  });

  it('rejects_with_6020_when_a_valid_signature_comes_from_an_unregistered_key', async () => {
    const c = await newCase(f, { key: freshKey() });
    await expectRejected(c, ORACLE_ERROR__ATTESTER_MISMATCH);
  });

  it('rejects_with_6020_when_the_key_belongs_to_a_different_registered_entry', async () => {
    const otherKey = freshKey();
    await registerKey(f.h, otherKey);
    const c = await newCase(f, { key: otherKey });
    await expectRejected(c, ORACLE_ERROR__ATTESTER_MISMATCH);
  });

  it('rejects_with_6021_when_an_oyster_entry_gets_proof_type_2', async () => {
    const c = await newCase(f, { payload: { proofType: 2 } });
    await expectRejected(c, ORACLE_ERROR__PROOF_TYPE_MISMATCH);
  });

  it('rejects_with_6021_when_an_oyster_entry_gets_proof_type_0', async () => {
    const c = await newCase(f, { payload: { proofType: 0 } });
    await expectRejected(c, ORACLE_ERROR__PROOF_TYPE_MISMATCH);
  });

  it('rejects_with_6021_when_an_aws_entry_gets_proof_type_1', async () => {
    const key = freshKey();
    const id = await registerKey(f.h, key, KIND_AWS_PCR0);
    const c = await newCase(f, { key, entryId: id, payload: { proofType: 1 } });
    await expectRejected(c, ORACLE_ERROR__PROOF_TYPE_MISMATCH);
  });

  it('accepts_an_aws_entry_with_proof_type_2', async () => {
    const key = freshKey();
    const id = await registerKey(f.h, key, KIND_AWS_PCR0);
    const c = await newCase(f, { key, entryId: id, payload: { proofType: 2 } });
    await submit(f, c.params);
    expect(await attestationExists(f, c.wallet)).toBe(true);
  });

  it.each([1, 2, 3])('accepts_tier_%i', async (tier) => {
    const c = await newCase(f, { payload: { tier } });
    await submit(f, c.params);
    expect(await attestationExists(f, c.wallet)).toBe(true);
  });

  it.each([0, 4, 255])('rejects_with_6022_tier_%i', async (tier) => {
    const c = await newCase(f, { payload: { tier } });
    await expectRejected(c, ORACLE_ERROR__INVALID_TIER);
  });
});

describe('submit_attestation: clock boundaries (6023 to 6025)', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await startFixture();
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  async function expectBaselineSucceeds(c: Case) {
    await submit(f, c.params);
    expect(await attestationExists(f, c.wallet)).toBe(true);
  }

  async function expectRejected(c: Case, code: number) {
    const failure = await submitExpectingFailure(f, c.params);
    expect(failure.code).toBe(code);
    expect(await attestationExists(f, c.wallet)).toBe(false);
  }

  it('accepts_issued_at_exactly_now_plus_300', async () => {
    await expectBaselineSucceeds(await newCase(f, { issuedAtOffset: MAX_SKEW_SECS }));
  });

  it('rejects_with_6023_issued_at_now_plus_301', async () => {
    await expectRejected(
      await newCase(f, { issuedAtOffset: MAX_SKEW_SECS + 1n }),
      ORACLE_ERROR__ISSUED_IN_FUTURE,
    );
  });

  it('accepts_expiry_exactly_now', async () => {
    const c = await newCase(f, { issuedAtOffset: -100n });
    await expectBaselineSucceeds({ ...c, params: { ...c.params, expiry: c.now } });
  });

  it('rejects_with_6024_expiry_one_second_before_now', async () => {
    const c = await newCase(f, { issuedAtOffset: -100n });
    const late = { ...c, params: { ...c.params, expiry: c.now - 1n } };
    await expectRejected(late, ORACLE_ERROR__SIGNATURE_EXPIRED);
  });

  it('accepts_a_lifetime_of_exactly_600', async () => {
    await expectBaselineSucceeds(await newCase(f, { issuedAtOffset: -10n }));
  });

  it('rejects_with_6025_a_lifetime_of_601', async () => {
    const c = await newCase(f, { issuedAtOffset: -10n });
    const long = { ...c, params: { ...c.params, expiry: c.now - 10n + 601n } };
    await expectRejected(long, ORACLE_ERROR__EXPIRY_TOO_FAR);
  });

  it('accepts_a_lifetime_of_one_second', async () => {
    const c = await newCase(f);
    await expectBaselineSucceeds({ ...c, params: { ...c.params, expiry: c.now + 1n } });
  });

  it('rejects_with_6025_expiry_equal_to_issued_at', async () => {
    const c = await newCase(f);
    await expectRejected(
      { ...c, params: { ...c.params, expiry: c.now } },
      ORACLE_ERROR__EXPIRY_TOO_FAR,
    );
  });

  it('rejects_with_6025_expiry_before_issued_at', async () => {
    const c = await newCase(f, { issuedAtOffset: 10n });
    await expectRejected(
      { ...c, params: { ...c.params, expiry: c.now + 5n } },
      ORACLE_ERROR__EXPIRY_TOO_FAR,
    );
  });

  it('rejects_with_6024_after_the_clock_passes_a_signed_expiry', async () => {
    const c = await newCase(f);
    await timeTravel(f.h, c.now + 601n);
    await expectRejected(c, ORACLE_ERROR__SIGNATURE_EXPIRED);
  });
});

describe('submit_attestation: check order for adjacent faults', () => {
  let f: Fixture;
  let revoked: { key: ReturnType<typeof freshKey>; id: number };
  let awsEntry: { key: ReturnType<typeof freshKey>; id: number };

  beforeAll(async () => {
    f = await startFixture();
    const revokedKey = freshKey();
    const revokedId = await registerKey(f.h, revokedKey);
    await revokeEntry(f.h, revokedId);
    revoked = { key: revokedKey, id: revokedId };
    const awsKey = freshKey();
    awsEntry = { key: awsKey, id: await registerKey(f.h, awsKey, KIND_AWS_PCR0) };
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  const cases: readonly { name: string; expected: number; make: () => Promise<Case> }[] = [
    {
      name: '6012_before_6013_layout_and_tag',
      expected: ORACLE_ERROR__INVALID_PRECOMPILE_LAYOUT,
      make: () =>
        newCase(f, { params: { buildData: trailingByte, mutateMessage: flipFirstTagByte } }),
    },
    {
      name: '6013_before_6014_tag_and_program',
      expected: ORACLE_ERROR__WRONG_DOMAIN_TAG,
      make: async () =>
        newCase(f, {
          params: { mutateMessage: flipFirstTagByte, message: { programId: await stranger() } },
        }),
    },
    {
      name: '6014_before_6015_program_and_credential',
      expected: ORACLE_ERROR__WRONG_PROGRAM_ID,
      make: async () =>
        newCase(f, {
          params: { message: { programId: await stranger(), credential: await stranger() } },
        }),
    },
    {
      name: '6015_before_6016_credential_and_schema',
      expected: ORACLE_ERROR__CREDENTIAL_MISMATCH,
      make: async () =>
        newCase(f, {
          params: { message: { credential: await stranger(), schema: await stranger() } },
        }),
    },
    {
      name: '6016_before_6017_schema_and_attestation_address',
      expected: ORACLE_ERROR__SCHEMA_MISMATCH,
      make: async () =>
        newCase(f, {
          params: {
            message: { schema: await stranger() },
            accounts: { attestation: await stranger() },
          },
        }),
    },
    {
      name: '6017_before_6018_attestation_address_and_entry_id',
      expected: ORACLE_ERROR__ATTESTATION_ADDRESS_MISMATCH,
      make: async () =>
        newCase(f, {
          payload: { measurementId: 99 },
          params: { accounts: { attestation: await stranger() } },
        }),
    },
    {
      name: '6018_before_6019_entry_id_and_revoked',
      expected: ORACLE_ERROR__ENCLAVE_ENTRY_MISMATCH,
      // Revoked entry account, payload names another id.
      make: () =>
        newCase(f, {
          key: revoked.key,
          entryId: revoked.id,
          payload: { measurementId: f.entryId },
        }),
    },
    {
      name: '6019_before_6020_revoked_and_attester',
      expected: ORACLE_ERROR__ENCLAVE_REVOKED,
      make: () => newCase(f, { key: freshKey(), entryId: revoked.id }),
    },
    {
      name: '6020_before_6021_attester_and_proof_type',
      expected: ORACLE_ERROR__ATTESTER_MISMATCH,
      make: () => newCase(f, { key: freshKey(), payload: { proofType: 2 } }),
    },
    {
      name: '6021_before_6022_proof_type_and_tier',
      expected: ORACLE_ERROR__PROOF_TYPE_MISMATCH,
      make: () =>
        newCase(f, { key: awsEntry.key, entryId: awsEntry.id, payload: { proofType: 1, tier: 0 } }),
    },
    {
      name: '6022_before_6023_tier_and_future',
      expected: ORACLE_ERROR__INVALID_TIER,
      make: () => newCase(f, { payload: { tier: 0 }, issuedAtOffset: MAX_SKEW_SECS + 1n }),
    },
    {
      name: '6023_before_6024_future_and_expired',
      expected: ORACLE_ERROR__ISSUED_IN_FUTURE,
      make: async () => {
        const c = await newCase(f, { issuedAtOffset: MAX_SKEW_SECS + 1n });
        return { ...c, params: { ...c.params, expiry: c.now - 1n } };
      },
    },
    {
      name: '6024_before_6025_expired_and_too_far',
      expected: ORACLE_ERROR__SIGNATURE_EXPIRED,
      make: async () => {
        const c = await newCase(f, { issuedAtOffset: -1_000n });
        return { ...c, params: { ...c.params, expiry: c.now - 1n } };
      },
    },
  ];

  it.each(cases)('reports_$name', async ({ expected, make }) => {
    const c = await make();
    const failure = await submitExpectingFailure(f, c.params);
    expect(failure.code).toBe(expected);
    expect(await attestationExists(f, c.wallet)).toBe(false);
  });

  it('reports_6025_before_6026_too_far_and_stale', async () => {
    const first = await newCase(f, { issuedAtOffset: 50n });
    await submit(f, first.params);
    // Older than stored (stale) and a 601 s lifetime (too far), still unexpired.
    const second = await newCase(f, { wallet: first.wallet, now: first.now, issuedAtOffset: -10n });
    const params = { ...second.params, expiry: second.now - 10n + 601n };
    const failure = await submitExpectingFailure(f, params);
    expect(failure.code).toBe(ORACLE_ERROR__EXPIRY_TOO_FAR);
    expect(failure.code).not.toBe(ORACLE_ERROR__STALE_ATTESTATION);
  });
});
