// `runPoolSetup` against the real demo-pool, oracle, SAS and SPL Token programs on an embedded
// surfnet. Needs `anchor build`. One surfnet per file; tests build on each other in order.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchMint } from '@solana-program/token';
import { unwrapOption } from '@solana/kit';
import {
  DEMO_POOL_PROGRAM_ADDRESS,
  fetchMaybePool,
  findPoolPda,
  findVaultPda,
} from '@tio/demo-pool-client';
import { ORACLE_PROGRAM_ADDRESS } from '@tio/oracle-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONE_TOKEN, POOL_DEFAULTS, runPoolSetup } from './pool-setup.ts';
import { runSasSetup } from './sas-setup.ts';
import {
  type OpsChain,
  countingRpc,
  initializeOracleDirect,
  rejection,
  startOpsChain,
  tokenBalance,
} from './testing/chain.ts';

const POLICY_HASH = new Uint8Array(32).fill(0x81);
const APPROVED_IDS = [0, 9];

let chain: OpsChain;
let dir: string;
let deploymentPath: string;
let sas: { credential: string; schema: string };

function setup(
  overrides: Partial<Parameters<typeof runPoolSetup>[0]> = {},
  rpc = chain.rpc,
): ReturnType<typeof runPoolSetup> {
  return runPoolSetup({
    cluster: 'localnet',
    rpc,
    rpcSubscriptions: chain.rpcSubscriptions,
    admin: chain.admin,
    deploymentPath,
    policyHash: POLICY_HASH,
    approvedIds: APPROVED_IDS,
    poolId: POOL_DEFAULTS.poolId,
    tierLimits: POOL_DEFAULTS.tierLimits,
    ...overrides,
  });
}

async function readDeploymentFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(deploymentPath, 'utf8')) as Record<string, unknown>;
}

async function secondPoolAddress() {
  const [pool] = await findPoolPda({ admin: chain.admin.address, poolId: 1 });
  return pool;
}

async function poolAddresses() {
  const [pool] = await findPoolPda({ admin: chain.admin.address, poolId: POOL_DEFAULTS.poolId });
  const [vault] = await findVaultPda({ pool });
  return { pool, vault };
}

function bitmapOf(...ids: number[]): Uint8Array {
  const bitmap = new Uint8Array(32);
  for (const id of ids)
    bitmap[Math.floor(id / 8)] = (bitmap[Math.floor(id / 8)] ?? 0) | (1 << (id % 8));
  return bitmap;
}

describe('runPoolSetup on surfpool', () => {
  beforeAll(async () => {
    chain = await startOpsChain();
    await initializeOracleDirect(chain);
    const { deployment } = await runSasSetup({
      rpc: chain.rpc,
      rpcSubscriptions: chain.rpcSubscriptions,
      admin: chain.admin,
      oracleProgramId: ORACLE_PROGRAM_ADDRESS,
      cluster: 'localnet',
    });
    sas = { credential: deployment.credential, schema: deployment.schema };
    dir = await mkdtemp(join(tmpdir(), 'pool-setup-'));
    deploymentPath = join(dir, 'localnet.json');
    await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
  });

  afterAll(async () => {
    chain.surfnet.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses_a_cluster_name_the_rpc_does_not_serve_and_sends_nothing', async () => {
    const counted = countingRpc(chain.rpc);
    const failure = await rejection(setup({ cluster: 'devnet' }, counted.rpc));
    expect(failure).toMatchObject({ code: 'cluster_mismatch' });
    expect(counted.sent()).toBe(0);
    const { pool } = await poolAddresses();
    expect((await fetchMaybePool(chain.rpc, pool)).exists).toBe(false);
  });

  let first: Awaited<ReturnType<typeof runPoolSetup>>;

  it('creates_mint_pool_and_funded_vault_on_first_run', async () => {
    first = await setup();
    const { pool, vault } = await poolAddresses();
    expect(first.created).toBe(true);
    expect(first.pool).toBe(pool);
    expect(first.vault).toBe(vault);
  });

  it('creates_a_six_decimal_mint_without_freeze_authority_owned_by_the_admin', async () => {
    const mint = await fetchMint(chain.rpc, first.mint);
    expect(mint.data.decimals).toBe(6);
    expect(unwrapOption(mint.data.freezeAuthority)).toBeNull();
    expect(unwrapOption(mint.data.mintAuthority)).toBe(chain.admin.address);
  });

  it('funds_the_vault_with_the_default_amount', async () => {
    expect(await tokenBalance(chain.rpc, first.vault)).toBe(POOL_DEFAULTS.vaultFunding);
  });

  it('stores_the_default_params_policy_hash_and_approved_ids_in_the_pool', async () => {
    const { pool } = await poolAddresses();
    const account = await fetchMaybePool(chain.rpc, pool);
    expect(account.exists).toBe(true);
    if (!account.exists) return;
    const { data } = account;
    expect(data.admin).toBe(chain.admin.address);
    expect(data.poolId).toBe(POOL_DEFAULTS.poolId);
    expect(data.mint).toBe(first.mint);
    expect(data.credential).toBe(sas.credential);
    expect(data.schema).toBe(sas.schema);
    expect(new Uint8Array(data.params.policyHash)).toEqual(POLICY_HASH);
    expect(data.params.tierLimits).toEqual([...POOL_DEFAULTS.tierLimits]);
    expect(data.params.maxAgeSecs).toBe(POOL_DEFAULTS.maxAgeSecs);
    expect(data.params.maxWindowAgeSecs).toBe(POOL_DEFAULTS.maxWindowAgeSecs);
    expect(data.params.minWindowSecs).toBe(POOL_DEFAULTS.minWindowSecs);
    expect(new Uint8Array(data.params.approvedMeasurements)).toEqual(bitmapOf(...APPROVED_IDS));
  });

  it('merges_mint_program_and_pools_into_the_deployment_keeping_the_sas_keys', async () => {
    const { pool } = await poolAddresses();
    const deployment = await readDeploymentFile();
    expect(deployment['mint']).toBe(first.mint);
    expect(deployment['demo_pool_program']).toBe(DEMO_POOL_PROGRAM_ADDRESS);
    expect(deployment['pools']).toEqual([{ address: pool, pool_id: POOL_DEFAULTS.poolId }]);
    expect(deployment['credential']).toBe(sas.credential);
    expect(deployment['schema']).toBe(sas.schema);
  });

  it('is_a_no_op_on_a_re_run_and_sends_nothing', async () => {
    const counted = countingRpc(chain.rpc);
    const again = await setup({}, counted.rpc);
    expect(again).toEqual({ ...first, created: false });
    expect(counted.sent()).toBe(0);
    expect(await tokenBalance(chain.rpc, first.vault)).toBe(POOL_DEFAULTS.vaultFunding);
  });

  it('keeps_other_pools_listed_in_the_deployment_on_a_re_run', async () => {
    const other = { address: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq', pool_id: 1 };
    const before = await readDeploymentFile();
    await writeFile(
      deploymentPath,
      `${JSON.stringify({ ...before, pools: [other, ...(before['pools'] as unknown[])] }, null, 2)}\n`,
    );
    await setup();
    const { pool } = await poolAddresses();
    expect((await readDeploymentFile())['pools']).toEqual([
      other,
      { address: pool, pool_id: POOL_DEFAULTS.poolId },
    ]);
  });

  it('fails_pool_mismatch_when_the_existing_pool_has_a_different_policy_hash', async () => {
    const counted = countingRpc(chain.rpc);
    const failure = await rejection(
      setup({ policyHash: new Uint8Array(32).fill(0x22) }, counted.rpc),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: 'pool_mismatch' });
    expect(counted.sent()).toBe(0);
    const { pool } = await poolAddresses();
    const account = await fetchMaybePool(chain.rpc, pool);
    expect(account.exists && new Uint8Array(account.data.params.policyHash)).toEqual(POLICY_HASH);
  });

  describe('a second pool', () => {
    const POOL_1_LIMITS = [3000n * ONE_TOKEN, 1000n * ONE_TOKEN, 0n] as const;
    let second: Awaited<ReturnType<typeof runPoolSetup>>;

    const secondPoolInput = (overrides: Partial<Parameters<typeof runPoolSetup>[0]> = {}) => ({
      poolId: 1,
      tierLimits: POOL_1_LIMITS,
      ...overrides,
    });

    it('creates_pool_1_next_to_pool_0_with_the_same_mint', async () => {
      const before = await readDeploymentFile();
      second = await setup(secondPoolInput());
      expect(second.created).toBe(true);
      expect(second.pool).toBe(await secondPoolAddress());
      expect(second.pool).not.toBe(first.pool);
      expect(second.mint).toBe(first.mint);
      expect((await readDeploymentFile())['mint']).toBe(before['mint']);
    });

    it('funds_the_vault_of_pool_1_with_the_default_amount_of_the_shared_mint', async () => {
      const [vault] = await findVaultPda({ pool: second.pool });
      expect(second.vault).toBe(vault);
      expect(await tokenBalance(chain.rpc, vault)).toBe(POOL_DEFAULTS.vaultFunding);
    });

    it('stores_the_given_tier_limits_including_a_zero_c_and_the_pool_id', async () => {
      const account = await fetchMaybePool(chain.rpc, second.pool);
      expect(account.exists).toBe(true);
      if (!account.exists) return;
      expect(account.data.poolId).toBe(1);
      expect(account.data.mint).toBe(first.mint);
      expect(account.data.params.tierLimits).toEqual([...POOL_1_LIMITS]);
    });

    it('lists_both_pools_in_the_deployment', async () => {
      const { pool } = await poolAddresses();
      const pools = (await readDeploymentFile())['pools'];
      expect(pools).toEqual(
        expect.arrayContaining([
          { address: pool, pool_id: POOL_DEFAULTS.poolId },
          { address: second.pool, pool_id: 1 },
        ]),
      );
    });

    it('is_a_no_op_on_a_re_run_of_pool_1_and_sends_nothing', async () => {
      const counted = countingRpc(chain.rpc);
      const again = await setup(secondPoolInput(), counted.rpc);
      expect(again).toEqual({ ...second, created: false });
      expect(counted.sent()).toBe(0);
    });

    it('fails_pool_mismatch_for_pool_1_when_tier_limits_differ_and_leaves_pool_0_untouched', async () => {
      const counted = countingRpc(chain.rpc);
      const failure = await rejection(
        setup(
          secondPoolInput({ tierLimits: [3000n * ONE_TOKEN, 2000n * ONE_TOKEN, 0n] }),
          counted.rpc,
        ),
      );
      expect(failure).toMatchObject({ code: 'pool_mismatch' });
      expect(counted.sent()).toBe(0);
      const { pool } = await poolAddresses();
      const account = await fetchMaybePool(chain.rpc, pool);
      expect(account.exists && account.data.params.tierLimits).toEqual([
        ...POOL_DEFAULTS.tierLimits,
      ]);
    });

    it('generates_a_new_mint_for_pool_0_of_a_fresh_deployment_without_a_mint', async () => {
      // Another admin, so pool 0 does not exist yet for it; the file has no `mint` key.
      const admin = chain.outsider;
      const { deployment } = await runSasSetup({
        rpc: chain.rpc,
        rpcSubscriptions: chain.rpcSubscriptions,
        admin,
        oracleProgramId: ORACLE_PROGRAM_ADDRESS,
        cluster: 'localnet',
      });
      const freshPath = join(dir, 'fresh.json');
      await writeFile(freshPath, `${JSON.stringify(deployment, null, 2)}\n`);
      const result = await setup({
        admin,
        deploymentPath: freshPath,
        poolId: POOL_DEFAULTS.poolId,
        tierLimits: [...POOL_DEFAULTS.tierLimits],
      });
      expect(result.created).toBe(true);
      expect(result.mint).not.toBe(first.mint);
      const written = JSON.parse(await readFile(freshPath, 'utf8')) as Record<string, unknown>;
      expect(written['mint']).toBe(result.mint);
    });
  });
});
