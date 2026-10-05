import {
  ORACLE_ERROR__ALREADY_REVOKED,
  ORACLE_ERROR__NOT_ADMIN,
  fetchConfig,
  fetchEnclaveEntry,
  findConfigPda,
  findEnclaveEntryPda,
  getRevokeEnclaveInstruction,
} from '@tio/oracle-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnclaveRevokedEvent } from './events.ts';
import {
  ANCHOR_ACCOUNT_NOT_INITIALIZED,
  ANCHOR_CONSTRAINT_SEEDS,
  type Harness,
  eventPayloads,
  initializeOracle,
  registerIx,
  revokeIx,
  send,
  sendExpectingCustomError,
  startHarness,
} from './harness.ts';

async function nextId(h: Harness): Promise<number> {
  const [configAddress] = await findConfigPda();
  return (await fetchConfig(h.rpc, configAddress)).data.nextMeasurementId;
}

async function entryOf(h: Harness, id: number) {
  const [address] = await findEnclaveEntryPda({ measurementId: id });
  return (await fetchEnclaveEntry(h.rpc, address)).data;
}

describe('revoke_enclave', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await initializeOracle(h);
  });

  afterAll(() => {
    h.surfnet.stop();
  });

  async function registerOne(): Promise<number> {
    const id = await nextId(h);
    await send(h, h.admin, [await registerIx(h, id)]);
    return id;
  }

  it('sets_revoked_at_to_the_clock', async () => {
    const id = await registerOne();
    const before = Math.floor(Date.now() / 1000);

    await send(h, h.admin, [await revokeIx(h, id)]);

    const entry = await entryOf(h, id);
    expect(entry.revokedAt).toBeGreaterThan(0n);
    expect(entry.revokedAt).toBeLessThanOrEqual(BigInt(before + 60));
    expect(entry.revokedAt).toBeGreaterThanOrEqual(entry.registeredAt);
  });

  it('emits_enclave_revoked_with_the_id', async () => {
    const id = await registerOne();

    const signature = await send(h, h.admin, [await revokeIx(h, id)]);

    const events = (await eventPayloads(h, signature)).map((p) => parseEnclaveRevokedEvent(p));
    expect(events).toEqual([{ measurementId: id }]);
  });

  it('rejects_a_signer_that_is_not_the_admin', async () => {
    const id = await registerOne();

    const code = await sendExpectingCustomError(h, h.attacker, [await revokeIx(h, id, h.attacker)]);

    expect(code).toBe(ORACLE_ERROR__NOT_ADMIN);
    expect((await entryOf(h, id)).revokedAt).toBe(0n);
    // Baseline: the same instruction signed by the admin succeeds.
    await send(h, h.admin, [await revokeIx(h, id)]);
    expect((await entryOf(h, id)).revokedAt).toBeGreaterThan(0n);
  });

  it('rejects_revoking_twice_and_keeps_the_first_timestamp', async () => {
    const id = await registerOne();
    await send(h, h.admin, [await revokeIx(h, id)]);
    const first = (await entryOf(h, id)).revokedAt;

    const code = await sendExpectingCustomError(h, h.admin, [await revokeIx(h, id)]);

    expect(code).toBe(ORACLE_ERROR__ALREADY_REVOKED);
    expect((await entryOf(h, id)).revokedAt).toBe(first);
  });

  it('rejects_an_unknown_id_as_account_not_initialized', async () => {
    const unknown = (await nextId(h)) + 10;

    const code = await sendExpectingCustomError(h, h.admin, [await revokeIx(h, unknown)]);

    expect(code).toBe(ANCHOR_ACCOUNT_NOT_INITIALIZED);
  });

  // Check order: Anchor loads accounts before checking has_one, so an unknown
  // id fails as uninitialized even for a non-admin signer.
  it('checks_entry_exists_before_admin', async () => {
    const unknown = (await nextId(h)) + 10;
    const code = await sendExpectingCustomError(h, h.attacker, [
      await revokeIx(h, unknown, h.attacker),
    ]);
    expect(code).toBe(ANCHOR_ACCOUNT_NOT_INITIALIZED);
  });

  // Check order: config's has_one (NotAdmin) runs before the entry's seeds.
  it('checks_admin_before_entry_seeds', async () => {
    const first = await registerOne();
    const second = await registerOne();
    const [secondEntry] = await findEnclaveEntryPda({ measurementId: second });
    const [config] = await findConfigPda();
    const mismatched = getRevokeEnclaveInstruction({
      admin: h.attacker,
      config,
      enclaveEntry: secondEntry,
      measurementId: first,
    });

    const code = await sendExpectingCustomError(h, h.attacker, [mismatched]);

    expect(code).toBe(ORACLE_ERROR__NOT_ADMIN);
  });

  // The entry's seeds tie it to `measurement_id`; without that check the event
  // (and any later reader) would name the wrong id.
  it('rejects_an_entry_that_does_not_match_the_measurement_id', async () => {
    const first = await registerOne();
    const second = await registerOne();
    const [secondEntry] = await findEnclaveEntryPda({ measurementId: second });
    const [config] = await findConfigPda();
    const mismatched = getRevokeEnclaveInstruction({
      admin: h.admin,
      config,
      enclaveEntry: secondEntry,
      measurementId: first,
    });

    const code = await sendExpectingCustomError(h, h.admin, [mismatched]);

    expect(code).toBe(ANCHOR_CONSTRAINT_SEEDS);
    expect((await entryOf(h, second)).revokedAt).toBe(0n);
    // Baseline: the matching pair revokes.
    await send(h, h.admin, [await revokeIx(h, first)]);
    expect((await entryOf(h, first)).revokedAt).toBeGreaterThan(0n);
  });

  it('never_reuses_a_revoked_id', async () => {
    const revokedId = await registerOne();
    await send(h, h.admin, [await revokeIx(h, revokedId)]);

    const newId = await registerOne();

    expect(newId).toBe(revokedId + 1);
    expect((await entryOf(h, revokedId)).revokedAt).toBeGreaterThan(0n);
    expect((await entryOf(h, newId)).revokedAt).toBe(0n);
  });
});
