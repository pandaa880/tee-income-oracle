import { type Address, generateKeyPairSigner } from '@solana/kit';
import {
  ORACLE_ERROR__INVALID_EXISTING_ATTESTATION,
  ORACLE_ERROR__STALE_ATTESTATION,
  ORACLE_PROGRAM_ADDRESS,
  findSasSignerPda,
} from '@tio/oracle-client';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ATTESTATION_TTL_SECS,
  MESSAGE_LEN,
  PAYLOAD_LEN,
  PRECOMPILE_DATA_LEN,
  SAS_ATTESTATION_DISCRIMINATOR,
  SAS_ATTESTATION_LEN,
  SAS_PROGRAM_ID,
  SYSTEM_PROGRAM,
  buildMessage,
  buildPayload,
  buildPrecompileData,
  fetchRaw,
  plantAccount,
  readAttestation,
  recoverEthAddress,
  sasShapedAccount,
  signMessage,
} from './attest.ts';
import {
  type Case,
  type Fixture,
  attestationExists,
  attestationOf,
  failingInstructionIndex,
  freshKey,
  newCase,
  registerKey,
  startFixture,
  submit,
  submitExpectingFailure,
} from './attest-fixture.ts';
import { parseAttestationSubmittedEvent } from './events.ts';
import { eventPayloads } from './harness.ts';

const ANCHOR_CONSTRAINT_SEEDS = 2006;
const ANCHOR_CONSTRAINT_ADDRESS = 2012;
const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012;
// The harness puts a compute-budget ix first, so the precompile is ix 1.
const PRECOMPILE_IX_INDEX = 1;
// agave `PrecompileError::InvalidSignature`: the recovered address differs
// from the one in the instruction (or recovery fails).
const PRECOMPILE_ERROR_INVALID_SIGNATURE = 2;

type VectorSession = {
  now_unix: number;
  wallet: Address;
  attest: {
    oracle_program_id: Address;
    sas_credential: Address;
    sas_schema: Address;
    proof_type: number;
    measurement_id: number;
    expiry_unix: number;
  };
};

type VectorExpected = {
  policy_hash: string;
  consent_hash: string;
  window_from: number;
  window_to: number;
  payload_hex: string;
  msg_hex: string;
};

async function stranger(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}

function hex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'));
}

function submittedEvent(payloads: Uint8Array[]) {
  for (const payload of payloads) {
    try {
      return parseAttestationSubmittedEvent(payload);
    } catch {
      // another event (or program data); keep looking
    }
  }
  throw new Error('no AttestationSubmitted event in the logs');
}

describe('submit_attestation test helpers', () => {
  it('signs_so_that_the_precompile_address_recovers', () => {
    const key = freshKey();
    const message = new Uint8Array(MESSAGE_LEN).fill(7);
    const signature = signMessage(key.secretKey, message);
    expect(signature).toHaveLength(65);
    expect(recoverEthAddress(signature, message)).toEqual(key.ethAddress);
  });

  it('builds_the_329_byte_precompile_layout', () => {
    const key = freshKey();
    const message = new Uint8Array(MESSAGE_LEN).fill(7);
    const data = buildPrecompileData(key, message, 5);
    expect(data).toHaveLength(PRECOMPILE_DATA_LEN);
    expect(Array.from(data.subarray(0, 12))).toEqual([1, 32, 0, 5, 12, 0, 5, 97, 0, 232, 0, 5]);
    expect(data.subarray(12, 32)).toEqual(key.ethAddress);
    expect(data.subarray(97)).toEqual(message);
  });

  it('matches_the_test_vector_message_and_payload_bytes', () => {
    const dir = new URL('../../../../test-vectors/vectors/salaried_steady/', import.meta.url);
    const session = JSON.parse(readFileSync(new URL('session.json', dir), 'utf8')) as VectorSession;
    const expected = JSON.parse(
      readFileSync(new URL('expected.json', dir), 'utf8'),
    ) as VectorExpected;
    const payload = buildPayload({
      tier: 1, // "A"
      proofType: session.attest.proof_type,
      measurementId: session.attest.measurement_id,
      policyHash: hex(expected.policy_hash),
      consentHash: hex(expected.consent_hash),
      issuedAt: BigInt(session.now_unix),
      windowFrom: expected.window_from,
      windowTo: expected.window_to,
    });
    expect(Buffer.from(payload).toString('hex')).toBe(expected.payload_hex);

    const message = buildMessage({
      programId: session.attest.oracle_program_id,
      credential: session.attest.sas_credential,
      schema: session.attest.sas_schema,
      wallet: session.wallet,
      payload: hex(expected.payload_hex),
      expiry: BigInt(session.attest.expiry_unix),
    });
    expect(message).toHaveLength(MESSAGE_LEN);
    expect(Buffer.from(message).toString('hex')).toBe(expected.msg_hex);
  });
});

describe('submit_attestation: create', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await startFixture();
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  async function created(c: Case) {
    const signature = await submit(f, c.params);
    const stored = await readAttestation(f.h, await attestationOf(f, c.wallet));
    return { signature, stored };
  }

  it('creates_a_256_byte_attestation_owned_by_sas', async () => {
    const c = await newCase(f);
    const { stored } = await created(c);
    expect(stored).toBeDefined();
    expect(stored?.owner).toBe(SAS_PROGRAM_ID);
    expect(stored?.length).toBe(SAS_ATTESTATION_LEN);
    expect(stored?.discriminator).toBe(SAS_ATTESTATION_DISCRIMINATOR);
  });

  it('stores_the_signed_payload_bytes_exactly', async () => {
    const c = await newCase(f, { payload: { tier: 2 } });
    const { stored } = await created(c);
    expect(stored?.data).toHaveLength(PAYLOAD_LEN);
    expect(stored?.data).toEqual(c.params.payload);
  });

  it('uses_the_wallet_as_nonce_and_binds_credential_and_schema', async () => {
    const c = await newCase(f);
    const { stored } = await created(c);
    expect(stored?.nonce).toBe(c.wallet);
    expect(stored?.credential).toBe(f.credential);
    expect(stored?.schema).toBe(f.schema);
  });

  it('signs_the_sas_write_with_the_sas_signer_pda', async () => {
    const c = await newCase(f);
    const { stored } = await created(c);
    const [sasSigner] = await findSasSignerPda();
    expect(stored?.signer).toBe(sasSigner);
  });

  it('sets_the_sas_expiry_to_issued_at_plus_30_days', async () => {
    const c = await newCase(f, { issuedAtOffset: -20n });
    const { stored } = await created(c);
    expect(stored?.expiry).toBe(c.now - 20n + ATTESTATION_TTL_SECS);
  });

  it('emits_attestation_submitted_with_refreshed_false', async () => {
    const c = await newCase(f, { payload: { tier: 3 } });
    const { signature } = await created(c);
    const event = submittedEvent(await eventPayloads(f.h, signature));
    expect(event).toEqual({
      subject: c.wallet,
      measurementId: f.entryId,
      tier: 3,
      issuedAt: c.now,
      refreshed: false,
    });
  });

  it('lets_any_relayer_submit_for_a_wallet', async () => {
    const c = await newCase(f, { params: { relayer: f.h.admin } });
    const { stored } = await created(c);
    expect(stored?.nonce).toBe(c.wallet);
  });

  it('charges_the_attestation_rent_to_the_relayer', async () => {
    const c = await newCase(f);
    const before = (await f.h.rpc.getBalance(f.relayer.address).send()).value;
    const { signature } = await created(c);
    const after = (await f.h.rpc.getBalance(f.relayer.address).send()).value;
    const tx = await f.h.rpc
      .getTransaction(signature as Parameters<typeof f.h.rpc.getTransaction>[0], {
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
    const raw = await fetchRaw(f.h, await attestationOf(f, c.wallet));
    expect(raw?.lamports).toBeGreaterThan(0n);
    expect(before - after).toBe((tx?.meta?.fee ?? 0n) + (raw?.lamports ?? 0n));
  });
});

describe('submit_attestation: refresh and replay', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await startFixture();
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  async function expectMismatch(c: Case) {
    const failure = await submitExpectingFailure(f, c.params);
    expect(failure.code).toBe(ORACLE_ERROR__STALE_ATTESTATION);
  }

  it('replaces_the_data_when_the_new_issued_at_is_newer', async () => {
    const first = await newCase(f, { payload: { tier: 1 } });
    await submit(f, first.params);
    const second = await newCase(f, {
      wallet: first.wallet,
      issuedAtOffset: 0n,
      payload: { tier: 2 },
    });
    // fresh era: second.now > first.now, so issued_at is newer
    await submit(f, second.params);

    const stored = await readAttestation(f.h, await attestationOf(f, first.wallet));
    expect(stored?.data).toEqual(second.params.payload);
    expect(stored?.expiry).toBe(second.now + ATTESTATION_TTL_SECS);
    expect(stored?.length).toBe(SAS_ATTESTATION_LEN);
  });

  it('emits_refreshed_true_on_replacement', async () => {
    const first = await newCase(f);
    await submit(f, first.params);
    const second = await newCase(f, { wallet: first.wallet });
    const signature = await submit(f, second.params);

    const event = submittedEvent(await eventPayloads(f.h, signature));
    expect(event.refreshed).toBe(true);
    expect(event.subject).toBe(first.wallet);
    expect(event.issuedAt).toBe(second.now);
  });

  async function balanceOf(address: Address): Promise<bigint> {
    return (await f.h.rpc.getBalance(address).send()).value;
  }

  async function feeOf(signature: string): Promise<bigint> {
    const tx = await f.h.rpc
      .getTransaction(signature as Parameters<typeof f.h.rpc.getTransaction>[0], {
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
    return tx?.meta?.fee ?? -1n;
  }

  it('refunds_the_old_rent_to_the_relayer_so_a_refresh_costs_only_the_fee', async () => {
    const first = await newCase(f);
    await submit(f, first.params);
    const second = await newCase(f, { wallet: first.wallet });

    const before = await balanceOf(f.relayer.address);
    const signature = await submit(f, second.params);
    const after = await balanceOf(f.relayer.address);

    const stored = await readAttestation(f.h, await attestationOf(f, first.wallet));
    expect(stored?.data).toEqual(second.params.payload);
    expect(before - after).toBe(await feeOf(signature));
  });

  it('refunds_the_rent_to_the_refreshing_relayer_not_the_original_payer', async () => {
    const first = await newCase(f);
    await submit(f, first.params);
    const refresher = f.h.admin;
    const second = await newCase(f, { wallet: first.wallet, params: { relayer: refresher } });
    const originalBefore = await balanceOf(f.relayer.address);
    const refresherBefore = await balanceOf(refresher.address);

    const signature = await submit(f, second.params);

    const stored = await readAttestation(f.h, await attestationOf(f, first.wallet));
    expect(stored?.data).toEqual(second.params.payload);
    expect(await balanceOf(f.relayer.address)).toBe(originalBefore);
    expect(refresherBefore - (await balanceOf(refresher.address))).toBe(await feeOf(signature));
  });

  it('rejects_an_exact_replay_of_the_same_signed_bytes_with_stale', async () => {
    const c = await newCase(f);
    await submit(f, c.params);
    await expectMismatch(c);
  });

  it('rejects_an_older_signature_after_a_newer_one_with_stale', async () => {
    const newer = await newCase(f, { issuedAtOffset: 10n });
    await submit(f, newer.params);
    // Same clock, signed 5 s earlier than "now": valid in time, older than stored.
    const older = await newCase(f, { wallet: newer.wallet, now: newer.now, issuedAtOffset: -5n });
    await expectMismatch(older);
  });

  it('accepts_a_newer_signature_in_the_same_clock_era', async () => {
    const first = await newCase(f, { issuedAtOffset: -5n });
    await submit(f, first.params);
    const second = await newCase(f, { wallet: first.wallet, now: first.now, issuedAtOffset: 5n });
    await submit(f, second.params);
    const stored = await readAttestation(f.h, await attestationOf(f, first.wallet));
    expect(stored?.data).toEqual(second.params.payload);
  });

  it('rejects_equal_issued_at_with_different_payload_with_stale', async () => {
    const first = await newCase(f, { payload: { tier: 1 } });
    await submit(f, first.params);
    const second = await newCase(f, {
      wallet: first.wallet,
      now: first.now,
      payload: { tier: 3 },
    });
    await expectMismatch(second);
  });

  it('leaves_the_stored_attestation_unchanged_after_a_stale_rejection', async () => {
    const c = await newCase(f, { payload: { tier: 2 } });
    await submit(f, c.params);
    const address = await attestationOf(f, c.wallet);
    const before = await fetchRaw(f.h, address);

    const stale = await newCase(f, { wallet: c.wallet, now: c.now, payload: { tier: 3 } });
    await expectMismatch(stale);

    const after = await fetchRaw(f.h, address);
    expect(after?.data).toEqual(before?.data);
    expect(after?.lamports).toBe(before?.lamports);
  });
});

describe('submit_attestation: the precompile really verifies', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await startFixture();
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  // Rejected by the secp256k1 precompile itself (instruction 1, behind the
  // harness compute-budget ix), not by an oracle `require!`.
  async function expectError(c: Case) {
    const failure = await submitExpectingFailure(f, c.params);
    expect(failingInstructionIndex(failure.error)).toBe(PRECOMPILE_IX_INDEX);
    expect(failure.code).toBe(PRECOMPILE_ERROR_INVALID_SIGNATURE);
    expect(await attestationExists(f, c.wallet)).toBe(false);
  }

  it('baseline_unmodified_signature_is_accepted', async () => {
    const c = await newCase(f);
    await submit(f, c.params);
    expect(await attestationExists(f, c.wallet)).toBe(true);
  });

  it('fails_the_transaction_when_a_signature_bit_is_flipped', async () => {
    const c = await newCase(f, {
      params: {
        mutateData: (data) => {
          data[40] = (data[40] ?? 0) ^ 1;
        },
      },
    });
    await expectError(c);
  });

  it('fails_the_transaction_when_a_payload_byte_is_changed_after_signing', async () => {
    const c = await newCase(f, {
      params: {
        mutateData: (data) => {
          // payload starts at message offset 141 inside the data at 97
          data[97 + 141 + 5] = (data[97 + 141 + 5] ?? 0) ^ 0xff;
        },
      },
    });
    await expectError(c);
  });

  it('fails_the_transaction_when_the_embedded_eth_address_is_swapped', async () => {
    const other = freshKey();
    const c = await newCase(f, {
      params: {
        mutateData: (data) => {
          data.set(other.ethAddress, 12);
        },
      },
    });
    await expectError(c);
  });
});

describe('submit_attestation: planted account at the attestation address', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await startFixture();
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  async function expectError(owner: Address, data: Uint8Array) {
    const c = await newCase(f);
    const address = await attestationOf(f, c.wallet);
    plantAccount(f.h, address, owner, data);

    const failure = await submitExpectingFailure(f, c.params);

    expect(failure.code).toBe(ORACLE_ERROR__INVALID_EXISTING_ATTESTATION);
    const after = await fetchRaw(f.h, address);
    expect(after?.owner).toBe(owner);
    expect(after?.data).toEqual(data);
  }

  it('rejects_a_system_owned_account_holding_data', async () => {
    await expectError(SYSTEM_PROGRAM, new Uint8Array(10).fill(9));
  });

  it('rejects_a_system_owned_account_shaped_like_an_attestation', async () => {
    await expectError(SYSTEM_PROGRAM, sasShapedAccount(SAS_ATTESTATION_DISCRIMINATOR));
  });

  it('rejects_an_account_owned_by_another_program', async () => {
    await expectError(ORACLE_PROGRAM_ADDRESS, sasShapedAccount(SAS_ATTESTATION_DISCRIMINATOR));
  });

  it('rejects_a_sas_owned_account_of_255_bytes', async () => {
    await expectError(
      SAS_PROGRAM_ID,
      sasShapedAccount(SAS_ATTESTATION_DISCRIMINATOR, SAS_ATTESTATION_LEN - 1),
    );
  });

  it('rejects_a_sas_owned_account_of_257_bytes', async () => {
    await expectError(
      SAS_PROGRAM_ID,
      sasShapedAccount(SAS_ATTESTATION_DISCRIMINATOR, SAS_ATTESTATION_LEN + 1),
    );
  });

  it('rejects_a_sas_owned_account_with_discriminator_1', async () => {
    await expectError(SAS_PROGRAM_ID, sasShapedAccount(1));
  });

  // Anyone can send lamports to a PDA address. If that blocked creation, one
  // lamport would deny a wallet its attestation for good. Below rent, SAS
  // tops the balance up; at or above rent it doesn't: two code paths.
  it.each([1, 10_000_000])(
    'creates_over_an_empty_system_account_prefunded_with_%i_lamports',
    async (lamports) => {
      const c = await newCase(f);
      const address = await attestationOf(f, c.wallet);
      plantAccount(f.h, address, SYSTEM_PROGRAM, new Uint8Array(0), lamports);
      expect((await fetchRaw(f.h, address))?.lamports).toBe(BigInt(lamports));

      const signature = await submit(f, c.params);

      const stored = await readAttestation(f.h, address);
      expect(stored?.owner).toBe(SAS_PROGRAM_ID);
      expect(stored?.data).toEqual(c.params.payload);
      expect(submittedEvent(await eventPayloads(f.h, signature))?.refreshed).toBe(false);
    },
  );
});

describe('submit_attestation: Anchor account constraints', () => {
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

  it('baseline_default_accounts_succeed', async () => {
    const c = await newCase(f);
    await submit(f, c.params);
    expect(await attestationExists(f, c.wallet)).toBe(true);
  });

  it('rejects_a_wrong_instructions_sysvar_with_2012', async () => {
    const c = await newCase(f, { params: { accounts: { instructions: await stranger() } } });
    await expectRejected(c, ANCHOR_CONSTRAINT_ADDRESS);
  });

  it('rejects_a_wrong_sas_program_with_2012', async () => {
    const fake = await stranger();
    const c = await newCase(f, { params: { accounts: { sasProgram: fake } } });
    await expectRejected(c, ANCHOR_CONSTRAINT_ADDRESS);
  });

  it('rejects_a_wrong_event_authority_with_2006', async () => {
    const c = await newCase(f, { params: { accounts: { sasEventAuthority: await stranger() } } });
    await expectRejected(c, ANCHOR_CONSTRAINT_SEEDS);
  });

  it('rejects_a_sas_signer_that_is_not_the_pda_with_2006', async () => {
    const c = await newCase(f, { params: { accounts: { sasSigner: await stranger() } } });
    await expectRejected(c, ANCHOR_CONSTRAINT_SEEDS);
  });

  it('rejects_an_uninitialized_enclave_entry_with_3012', async () => {
    const unusedId = 200;
    const c = await newCase(f, { entryId: unusedId });
    await expectRejected(c, ANCHOR_ACCOUNT_NOT_INITIALIZED);
  });

  it('accepts_a_second_registered_entry_for_its_own_payload_id', async () => {
    const key = freshKey();
    const id = await registerKey(f.h, key);
    const c = await newCase(f, { key, entryId: id });
    await submit(f, c.params);
    const stored = await readAttestation(f.h, await attestationOf(f, c.wallet));
    expect(stored?.data).toEqual(c.params.payload);
  });
});
