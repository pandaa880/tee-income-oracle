import { address as toAddress, generateKeyPairSigner } from '@solana/kit';
import {
  ORACLE_ERROR__NOT_UPGRADE_AUTHORITY,
  ORACLE_ERROR__PROGRAM_DATA_MISMATCH,
  ORACLE_ERROR__ZERO_ADMIN,
  ORACLE_PROGRAM_ADDRESS,
  fetchConfig,
  fetchMaybeConfig,
  findConfigPda,
} from '@tio/oracle-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Harness,
  ORACLE_SO_PATH,
  SYSTEM_ACCOUNT_ALREADY_IN_USE,
  initializeIx,
  programDataAddress,
  send,
  sendExpectingCustomError,
  setUpgradeAuthority,
  startHarness,
} from './harness.ts';

describe('initialize', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(() => {
    h.surfnet.stop();
  });

  // Negative tests run first, while the Config PDA does not exist yet.
  it('rejects_a_signer_that_is_not_the_upgrade_authority', async () => {
    // Baseline: the same instruction signed by the real upgrade authority is valid
    // (proven by the success test below, which uses identical inputs).
    const code = await sendExpectingCustomError(h, h.attacker, [await initializeIx(h, h.attacker)]);
    expect(code).toBe(ORACLE_ERROR__NOT_UPGRADE_AUTHORITY);
    expect((await fetchMaybeConfig(h.rpc, (await findConfigPda())[0])).exists).toBe(false);
  });

  it('rejects_program_data_of_another_program', async () => {
    const copyId = (await generateKeyPairSigner()).address;
    h.surfnet.deploy({ programId: copyId, soPath: ORACLE_SO_PATH });
    await setUpgradeAuthority(h, copyId, h.attacker.address);
    const copyProgramData = await programDataAddress(copyId);

    const code = await sendExpectingCustomError(h, h.attacker, [
      await initializeIx(h, h.attacker, copyProgramData),
    ]);

    expect(code).toBe(ORACLE_ERROR__PROGRAM_DATA_MISMATCH);
    expect((await fetchMaybeConfig(h.rpc, (await findConfigPda())[0])).exists).toBe(false);
  });

  it('rejects_an_all_zero_admin', async () => {
    const zeroAdmin = toAddress('11111111111111111111111111111111');
    const code = await sendExpectingCustomError(h, h.upgradeAuthority, [
      await initializeIx(h, undefined, undefined, zeroAdmin),
    ]);
    expect(code).toBe(ORACLE_ERROR__ZERO_ADMIN);
    expect((await fetchMaybeConfig(h.rpc, (await findConfigPda())[0])).exists).toBe(false);
  });

  it('stores_config_with_version_bump_admin_and_zero_counter', async () => {
    await send(h, h.upgradeAuthority, [await initializeIx(h)]);

    const [configAddress, bump] = await findConfigPda();
    const config = await fetchConfig(h.rpc, configAddress);
    expect(config.data.version).toBe(1);
    expect(config.data.bump).toBe(bump);
    expect(config.data.admin).toBe(h.admin.address);
    expect(config.data.nextMeasurementId).toBe(0);
    expect(config.programAddress).toBe(ORACLE_PROGRAM_ADDRESS);
  });

  it('rejects_a_second_initialize_as_account_already_in_use', async () => {
    const code = await sendExpectingCustomError(h, h.upgradeAuthority, [await initializeIx(h)]);
    expect(code).toBe(SYSTEM_ACCOUNT_ALREADY_IN_USE);
  });

  // Check order: Anchor creates `init` accounts before any other constraint,
  // so a re-initialize by a non-authority fails on the existing account first.
  it('checks_account_in_use_before_upgrade_authority', async () => {
    const code = await sendExpectingCustomError(h, h.attacker, [await initializeIx(h, h.attacker)]);
    expect(code).toBe(SYSTEM_ACCOUNT_ALREADY_IN_USE);
  });
});
