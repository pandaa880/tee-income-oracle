import { type KeyPairSigner, address as toAddress, generateKeyPairSigner } from '@solana/kit';
import {
  ORACLE_ERROR__NOT_ADMIN,
  ORACLE_ERROR__NOT_PENDING_ADMIN,
  ORACLE_ERROR__ZERO_ADMIN,
  fetchConfig,
  findConfigPda,
  getAcceptAdminInstructionAsync,
  getProposeAdminInstructionAsync,
} from '@tio/oracle-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAdminChangedEvent, parseAdminProposedEvent } from './events.ts';
import {
  type Harness,
  eventPayloads,
  initializeOracle,
  registerIx,
  send,
  sendExpectingCustomError,
  startHarness,
} from './harness.ts';

const LAMPORTS = 10_000_000_000;

async function config(h: Harness) {
  const [address] = await findConfigPda();
  return (await fetchConfig(h.rpc, address)).data;
}

async function nextId(h: Harness): Promise<number> {
  return (await config(h)).nextMeasurementId;
}

async function fundedSigner(h: Harness): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  h.surfnet.fundSol(signer.address, LAMPORTS);
  return signer;
}

function proposeIx(admin: KeyPairSigner, newAdmin: string) {
  return getProposeAdminInstructionAsync({ admin, newAdmin: toAddress(newAdmin) });
}

function acceptIx(newAdmin: KeyPairSigner) {
  return getAcceptAdminInstructionAsync({ newAdmin });
}

describe('admin change (propose_admin + accept_admin)', () => {
  let h: Harness;
  let next: KeyPairSigner;

  beforeAll(async () => {
    h = await startHarness();
    await initializeOracle(h);
    next = await fundedSigner(h);
  });

  afterAll(() => {
    h.surfnet.stop();
  });

  it('starts_with_no_pending_admin', async () => {
    expect((await config(h)).pendingAdmin).toEqual({ __option: 'None' });
  });

  it('rejects_accept_when_nothing_is_pending', async () => {
    const code = await sendExpectingCustomError(h, next, [await acceptIx(next)]);
    expect(code).toBe(ORACLE_ERROR__NOT_PENDING_ADMIN);
  });

  it('rejects_propose_by_a_signer_that_is_not_the_admin', async () => {
    const code = await sendExpectingCustomError(h, h.attacker, [
      await proposeIx(h.attacker, h.attacker.address),
    ]);
    expect(code).toBe(ORACLE_ERROR__NOT_ADMIN);
    expect((await config(h)).pendingAdmin).toEqual({ __option: 'None' });
  });

  it('rejects_an_all_zero_pending_admin', async () => {
    const code = await sendExpectingCustomError(h, h.admin, [
      await proposeIx(h.admin, '11111111111111111111111111111111'),
    ]);
    expect(code).toBe(ORACLE_ERROR__ZERO_ADMIN);
  });

  it('stores_the_pending_admin_and_emits_admin_proposed', async () => {
    const signature = await send(h, h.admin, [await proposeIx(h.admin, next.address)]);

    const state = await config(h);
    expect(state.pendingAdmin).toEqual({ __option: 'Some', value: next.address });
    expect(state.admin).toBe(h.admin.address);
    const events = (await eventPayloads(h, signature)).map((p) => parseAdminProposedEvent(p));
    expect(events).toEqual([{ admin: h.admin.address, pendingAdmin: next.address }]);
  });

  it('rejects_accept_by_a_signer_that_is_not_the_pending_admin', async () => {
    const code = await sendExpectingCustomError(h, h.attacker, [await acceptIx(h.attacker)]);
    expect(code).toBe(ORACLE_ERROR__NOT_PENDING_ADMIN);
    expect((await config(h)).admin).toBe(h.admin.address);
  });

  it('makes_the_pending_admin_the_admin_and_emits_admin_changed', async () => {
    const signature = await send(h, next, [await acceptIx(next)]);

    const state = await config(h);
    expect(state.admin).toBe(next.address);
    expect(state.pendingAdmin).toEqual({ __option: 'None' });
    const events = (await eventPayloads(h, signature)).map((p) => parseAdminChangedEvent(p));
    expect(events).toEqual([{ oldAdmin: h.admin.address, newAdmin: next.address }]);
  });

  it('rejects_a_second_accept_after_the_change', async () => {
    const code = await sendExpectingCustomError(h, next, [await acceptIx(next)]);
    expect(code).toBe(ORACLE_ERROR__NOT_PENDING_ADMIN);
  });

  it('gives_the_new_admin_the_registry_and_takes_it_from_the_old_one', async () => {
    const id = await nextId(h);
    const code = await sendExpectingCustomError(h, h.admin, [
      await registerIx(h, id, undefined, h.admin),
    ]);
    expect(code).toBe(ORACLE_ERROR__NOT_ADMIN);

    await send(h, next, [await registerIx(h, id, undefined, next)]);
    expect(await nextId(h)).toBe(id + 1);
  });
});

describe('admin change: a new proposal replaces the pending one', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await initializeOracle(h);
  });

  afterAll(() => {
    h.surfnet.stop();
  });

  it('lets_only_the_latest_proposed_admin_accept', async () => {
    const first = await fundedSigner(h);
    const second = await fundedSigner(h);
    await send(h, h.admin, [await proposeIx(h.admin, first.address)]);
    await send(h, h.admin, [await proposeIx(h.admin, second.address)]);

    const code = await sendExpectingCustomError(h, first, [await acceptIx(first)]);
    expect(code).toBe(ORACLE_ERROR__NOT_PENDING_ADMIN);

    await send(h, second, [await acceptIx(second)]);
    expect((await config(h)).admin).toBe(second.address);
  });
});
