// `runOracleInit` against the real oracle program on an embedded surfnet. Needs
// `anchor build` (target/deploy/{oracle,demo_pool}.so). One surfnet per file; tests build on
// each other in order.
import { fetchMaybeConfig, findConfigPda } from '@tio/oracle-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOracleInit } from './oracle-init.ts';
import {
  ORACLE_NOT_UPGRADE_AUTHORITY,
  type OpsChain,
  countingRpc,
  findCustomErrorCode,
  rejection,
  startOpsChain,
} from './testing/chain.ts';

let chain: OpsChain;

function init(
  overrides: Partial<Parameters<typeof runOracleInit>[0]> = {},
  rpc = chain.rpc,
): ReturnType<typeof runOracleInit> {
  return runOracleInit({
    cluster: 'localnet',
    rpc,
    rpcSubscriptions: chain.rpcSubscriptions,
    authority: chain.upgradeAuthority,
    admin: chain.admin.address,
    ...overrides,
  });
}

async function readConfig() {
  const [config] = await findConfigPda();
  return fetchMaybeConfig(chain.rpc, config);
}

describe('runOracleInit on surfpool', () => {
  beforeAll(async () => {
    chain = await startOpsChain();
  });

  afterAll(() => {
    chain.surfnet.stop();
  });

  it('refuses_a_cluster_name_the_rpc_does_not_serve_and_sends_nothing', async () => {
    const counted = countingRpc(chain.rpc);
    const failure = await rejection(init({ cluster: 'devnet' }, counted.rpc));
    expect(failure).toMatchObject({ code: 'cluster_mismatch' });
    expect(counted.sent()).toBe(0);
    expect((await readConfig()).exists).toBe(false);
  });

  it('surfaces_the_programs_not_upgrade_authority_error_for_another_signer', async () => {
    const failure = await rejection(init({ authority: chain.outsider }));
    expect(failure).toBeDefined();
    expect(findCustomErrorCode(failure)).toBe(ORACLE_NOT_UPGRADE_AUTHORITY);
    expect((await readConfig()).exists).toBe(false);
  });

  it('creates_the_config_on_first_run', async () => {
    expect(await init()).toEqual({ created: true });
    const config = await readConfig();
    expect(config.exists).toBe(true);
    if (!config.exists) return;
    expect(config.data.admin).toBe(chain.admin.address);
    expect(config.data.nextMeasurementId).toBe(0);
  });

  it('is_a_no_op_for_the_same_admin_and_sends_nothing', async () => {
    const counted = countingRpc(chain.rpc);
    expect(await init({}, counted.rpc)).toEqual({ created: false });
    expect(counted.sent()).toBe(0);
  });

  it('fails_admin_mismatch_for_another_admin_and_leaves_the_config_unchanged', async () => {
    const counted = countingRpc(chain.rpc);
    const failure = await rejection(init({ admin: chain.outsider.address }, counted.rpc));
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: 'admin_mismatch' });
    expect(counted.sent()).toBe(0);
    const config = await readConfig();
    expect(config.exists && config.data.admin).toBe(chain.admin.address);
  });
});
