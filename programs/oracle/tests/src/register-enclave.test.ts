import {
  ORACLE_ERROR__NOT_ADMIN,
  ORACLE_ERROR__REGISTRY_FULL,
  ORACLE_ERROR__UNKNOWN_MEASUREMENT_KIND,
  ORACLE_ERROR__ZERO_ATTESTATION_DOC_HASH,
  ORACLE_ERROR__ZERO_ATTESTER,
  ORACLE_ERROR__ZERO_MEASUREMENT,
  fetchConfig,
  fetchEnclaveEntry,
  fetchMaybeEnclaveEntry,
  findConfigPda,
  findEnclaveEntryPda,
} from '@tio/oracle-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnclaveRegisteredEvent } from './events.ts';
import {
  type EnclaveArgs,
  type Harness,
  KIND_AWS_PCR0,
  bytes,
  eventPayloads,
  initializeOracle,
  registerIx,
  send,
  sendExpectingCustomError,
  startHarness,
  validEnclave,
} from './harness.ts';

async function nextId(h: Harness): Promise<number> {
  const [configAddress] = await findConfigPda();
  return (await fetchConfig(h.rpc, configAddress)).data.nextMeasurementId;
}

async function entryExists(h: Harness, id: number): Promise<boolean> {
  const [address] = await findEnclaveEntryPda({ measurementId: id });
  return (await fetchMaybeEnclaveEntry(h.rpc, address)).exists;
}

describe('register_enclave', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await initializeOracle(h);
  });

  afterAll(() => {
    h.surfnet.stop();
  });

  async function expectRejected(args: EnclaveArgs, code: number, signer = h.admin) {
    const id = await nextId(h);
    const rejected = await sendExpectingCustomError(h, signer, [
      await registerIx(h, id, args, signer),
    ]);
    expect(rejected).toBe(code);
    expect(await entryExists(h, id)).toBe(false);
    expect(await nextId(h)).toBe(id);
  }

  // Proves the rejected transaction shape was otherwise valid: same id, good args, admin.
  async function expectBaselineSucceeds() {
    const id = await nextId(h);
    await send(h, h.admin, [await registerIx(h, id)]);
    expect(await nextId(h)).toBe(id + 1);
  }

  it('stores_the_entry_with_every_field', async () => {
    const id = await nextId(h);
    const args = validEnclave({ measurementKind: KIND_AWS_PCR0 });
    const before = Math.floor(Date.now() / 1000);

    await send(h, h.admin, [await registerIx(h, id, args)]);

    const [address, bump] = await findEnclaveEntryPda({ measurementId: id });
    const { data } = await fetchEnclaveEntry(h.rpc, address);
    expect(data.version).toBe(1);
    expect(data.bump).toBe(bump);
    expect(data.measurementId).toBe(id);
    expect(data.measurementKind).toBe(KIND_AWS_PCR0);
    expect(Array.from(data.measurement)).toEqual(Array.from(args.measurement));
    expect(Array.from(data.attester)).toEqual(Array.from(args.attester));
    expect(Array.from(data.attestationDocHash)).toEqual(Array.from(args.attestationDocHash));
    expect(data.registeredAt).toBeGreaterThan(0n);
    expect(data.registeredAt).toBeLessThanOrEqual(BigInt(before + 60));
    expect(data.revokedAt).toBe(0n);
  });

  it('increments_next_measurement_id_per_registration', async () => {
    const id = await nextId(h);
    await send(h, h.admin, [await registerIx(h, id)]);
    expect(await nextId(h)).toBe(id + 1);
    await send(h, h.admin, [await registerIx(h, id + 1)]);
    expect(await nextId(h)).toBe(id + 2);
    expect(await entryExists(h, id + 1)).toBe(true);
  });

  it('emits_enclave_registered_with_the_entry_fields', async () => {
    const id = await nextId(h);
    const args = validEnclave({ measurement: bytes(32, 0x11), attester: bytes(20, 0x22) });

    const signature = await send(h, h.admin, [await registerIx(h, id, args)]);

    const events = (await eventPayloads(h, signature)).map((p) => parseEnclaveRegisteredEvent(p));
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.measurementId).toBe(id);
    expect(event?.measurementKind).toBe(args.measurementKind);
    expect(Array.from(event?.measurement ?? [])).toEqual(Array.from(args.measurement));
    expect(Array.from(event?.attester ?? [])).toEqual(Array.from(args.attester));
    expect(Array.from(event?.attestationDocHash ?? [])).toEqual(
      Array.from(args.attestationDocHash),
    );
  });

  it('rejects_a_signer_that_is_not_the_admin', async () => {
    await expectRejected(validEnclave(), ORACLE_ERROR__NOT_ADMIN, h.attacker);
    await expectBaselineSucceeds();
  });

  it.each([0, 3])('rejects_measurement_kind_%i', async (kind) => {
    await expectRejected(
      validEnclave({ measurementKind: kind }),
      ORACLE_ERROR__UNKNOWN_MEASUREMENT_KIND,
    );
    await expectBaselineSucceeds();
  });

  it('rejects_an_all_zero_measurement', async () => {
    await expectRejected(
      validEnclave({ measurement: bytes(32, 0) }),
      ORACLE_ERROR__ZERO_MEASUREMENT,
    );
    await expectBaselineSucceeds();
  });

  it('rejects_an_all_zero_attester', async () => {
    await expectRejected(validEnclave({ attester: bytes(20, 0) }), ORACLE_ERROR__ZERO_ATTESTER);
    await expectBaselineSucceeds();
  });

  it('rejects_an_all_zero_attestation_doc_hash', async () => {
    await expectRejected(
      validEnclave({ attestationDocHash: bytes(32, 0) }),
      ORACLE_ERROR__ZERO_ATTESTATION_DOC_HASH,
    );
    await expectBaselineSucceeds();
  });

  it('checks_attester_before_attestation_doc_hash', async () => {
    await expectRejected(
      validEnclave({ attester: bytes(20, 0), attestationDocHash: bytes(32, 0) }),
      ORACLE_ERROR__ZERO_ATTESTER,
    );
    await expectBaselineSucceeds();
  });

  describe('check order', () => {
    it('checks_admin_before_args', async () => {
      await expectRejected(
        validEnclave({ measurementKind: 0 }),
        ORACLE_ERROR__NOT_ADMIN,
        h.attacker,
      );
    });

    it('checks_kind_before_measurement', async () => {
      await expectRejected(
        validEnclave({ measurementKind: 0, measurement: bytes(32, 0) }),
        ORACLE_ERROR__UNKNOWN_MEASUREMENT_KIND,
      );
    });

    it('checks_measurement_before_attester', async () => {
      await expectRejected(
        validEnclave({ measurement: bytes(32, 0), attester: bytes(20, 0) }),
        ORACLE_ERROR__ZERO_MEASUREMENT,
      );
    });
  });
});

describe('register_enclave registry capacity', () => {
  const BATCH = 5;
  const MAX_ENTRIES = 255;
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await initializeOracle(h);
  });

  afterAll(() => {
    h.surfnet.stop();
  });

  it('accepts_ids_0_to_254_then_rejects_id_255_as_registry_full', async () => {
    for (let start = 0; start < MAX_ENTRIES; start += BATCH) {
      const end = Math.min(start + BATCH, MAX_ENTRIES);
      const instructions = [];
      for (let id = start; id < end; id += 1) {
        instructions.push(await registerIx(h, id));
      }
      await send(h, h.admin, instructions);
    }
    expect(await nextId(h)).toBe(MAX_ENTRIES);
    expect(await entryExists(h, MAX_ENTRIES - 1)).toBe(true);

    const code = await sendExpectingCustomError(h, h.admin, [await registerIx(h, MAX_ENTRIES)]);

    expect(code).toBe(ORACLE_ERROR__REGISTRY_FULL);
    expect(await entryExists(h, MAX_ENTRIES)).toBe(false);
    expect(await nextId(h)).toBe(MAX_ENTRIES);
  });
});
