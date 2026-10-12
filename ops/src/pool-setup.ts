/**
 * `pool:setup`: a demo lending pool for one cluster (FORMATS §14). The first
 * run creates a classic SPL mint with **no freeze authority** (so nobody can
 * freeze the vault or a borrower's account and block `repay`); every pool of
 * the deployment shares that mint, so a second pool (`--pool-id 1`) reuses the
 * recorded one. Pool, vault and funding go in one transaction so a failure
 * leaves nothing half-built.
 *
 * The approved-measurement bitmap is set once here and afterwards owned by
 * `enclave:rotate`, so a re-run ignores it.
 */
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_PROGRAM_ADDRESS,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from '@solana-program/token';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  generateKeyPairSigner,
} from '@solana/kit';
import {
  DEMO_POOL_PROGRAM_ADDRESS,
  type PoolParams,
  fetchMaybePool,
  findPoolPda,
  findVaultPda,
  getCreatePoolInstructionAsync,
} from '@tio/demo-pool-client';
import { setMeasurementBit } from './bitmap.ts';
import { type Cluster, assertCluster } from './cluster.ts';
import {
  type DeploymentFile,
  isRecord,
  optionalAddress,
  readDeployment,
  requiredAddress,
  updateDeployment,
} from './deployments.ts';
import { OpsError } from './errors.ts';
import { type ChainClients, sendInstructions } from './send.ts';

export const ONE_TOKEN = 10n ** 6n;
const DAY_SECS = 86_400;

/** Demo values (4d decision Q6). Token amounts in base units of a 6-decimal mint. */
export const POOL_DEFAULTS = {
  poolId: 0,
  decimals: 6,
  tierLimits: [5_000n * ONE_TOKEN, 2_000n * ONE_TOKEN, 500n * ONE_TOKEN] as readonly [
    bigint,
    bigint,
    bigint,
  ],
  maxAgeSecs: 30 * DAY_SECS,
  maxWindowAgeSecs: 45 * DAY_SECS,
  minWindowSecs: 180 * DAY_SECS,
  vaultFunding: 1_000_000n * ONE_TOKEN,
} as const;

export type PoolState = {
  mint: Address;
  credential: Address;
  schema: Address;
  params: PoolParams;
};

export type PoolSetupPlan =
  | { ok: true; create: boolean }
  | { ok: false; code: 'pool_mismatch'; message: string };

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** The first field where `found` differs from `expected`, ignoring the approved bitmap. */
function firstDifference(found: PoolState, expected: PoolState): string | undefined {
  const { params: f } = found;
  const { params: e } = expected;
  if (found.mint !== expected.mint) return 'mint';
  if (found.credential !== expected.credential) return 'credential';
  if (found.schema !== expected.schema) return 'schema';
  if (!sameBytes(new Uint8Array(f.policyHash), new Uint8Array(e.policyHash))) return 'policy_hash';
  if (
    f.tierLimits.length !== e.tierLimits.length ||
    f.tierLimits.some((limit, i) => limit !== e.tierLimits[i])
  ) {
    return 'tier_limits';
  }
  if (f.maxAgeSecs !== e.maxAgeSecs) return 'max_age_secs';
  if (f.maxWindowAgeSecs !== e.maxWindowAgeSecs) return 'max_window_age_secs';
  if (f.minWindowSecs !== e.minWindowSecs) return 'min_window_secs';
  return undefined;
}

/** Create the pool, accept an equal one, or refuse a different one (fixing that is a human call). */
export function planPoolSetup(
  found: { pool: PoolState | null },
  expected: PoolState,
): PoolSetupPlan {
  if (found.pool === null) return { ok: true, create: true };
  const field = firstDifference(found.pool, expected);
  if (field === undefined) return { ok: true, create: false };
  return { ok: false, code: 'pool_mismatch', message: `existing pool has another ${field}` };
}

export type PoolSetupInput = ChainClients & {
  cluster: Cluster;
  /** Pays, becomes the pool admin and the mint authority. */
  admin: KeyPairSigner;
  /** `deployments/<cluster>.json`; must hold `credential` and `schema` (run `sas:setup` first). */
  deploymentPath: string;
  policyHash: Uint8Array;
  /** Registry ids the new pool approves (active entries at setup time). */
  approvedIds: number[];
  /** The `u8` PDA seed; pool 0 is the default demo pool. */
  poolId: number;
  /** Base units (6 decimals); `A > 0`, `A >= B >= C`, 0 = tier not accepted. */
  tierLimits: readonly [bigint, bigint, bigint];
};

export type PoolSetupResult = { created: boolean; pool: Address; mint: Address; vault: Address };

/**
 * Creates (or checks) pool `input.poolId` and records `mint`, `demo_pool_program`
 * and `pools` in the deployment file. The mint is generated only when neither the
 * deployment file nor the chain knows one; otherwise every pool shares it.
 *
 * @throws OpsError `cluster_mismatch`, `missing_deployment`, `pool_mismatch`.
 */
export async function runPoolSetup(input: PoolSetupInput): Promise<PoolSetupResult> {
  await assertCluster(input);
  const deployment = await readDeployment(input.deploymentPath);
  const credential = requiredAddress(deployment, 'credential', 'sas:setup');
  const schema = requiredAddress(deployment, 'schema', 'sas:setup');
  const [pool] = await findPoolPda({ admin: input.admin.address, poolId: input.poolId });
  const [vault] = await findVaultPda({ pool });
  const found = await fetchMaybePool(input.rpc, pool);

  const recordedMint = optionalAddress(deployment, 'mint');
  const mintSigner =
    found.exists || recordedMint !== undefined ? undefined : await generateKeyPairSigner();
  const mint = mintSigner?.address ?? recordedMint ?? (found.exists ? found.data.mint : undefined);
  if (mint === undefined) throw new OpsError('missing_deployment', 'no mint');
  const expected: PoolState = { mint, credential, schema, params: poolParams(input) };
  const plan = planPoolSetup({ pool: found.exists ? found.data : null }, expected);
  if (!plan.ok) throw new OpsError(plan.code, plan.message);

  if (plan.create) await createPool(input, expected, vault, mintSigner);
  await updateDeployment(input.deploymentPath, {
    mint,
    demo_pool_program: DEMO_POOL_PROGRAM_ADDRESS,
    // Merge: other pools listed here must stay, or `enclave:rotate` stops approving them.
    pools: withPool(deployment, { address: pool, pool_id: input.poolId }),
  });
  return { created: plan.create, pool, mint, vault };
}

type PoolRecord = { address: string; pool_id: number };

/** The deployment's `pools` with `record` added, or replaced in place if its address is listed. */
function withPool(deployment: DeploymentFile | null, record: PoolRecord): unknown[] {
  const listed = deployment?.['pools'];
  const pools: unknown[] = Array.isArray(listed) ? listed : [];
  const at = pools.findIndex((p) => isRecord(p) && p['address'] === record.address);
  return at === -1 ? [...pools, record] : pools.map((p, i) => (i === at ? record : p));
}

function poolParams(input: PoolSetupInput): PoolParams {
  return {
    policyHash: input.policyHash,
    tierLimits: [...input.tierLimits],
    maxAgeSecs: POOL_DEFAULTS.maxAgeSecs,
    maxWindowAgeSecs: POOL_DEFAULTS.maxWindowAgeSecs,
    minWindowSecs: POOL_DEFAULTS.minWindowSecs,
    approvedMeasurements: input.approvedIds.reduce(
      (bitmap, id) => setMeasurementBit(bitmap, id),
      new Uint8Array(32),
    ),
  };
}

/** Create + init a fresh mint (the admin is its authority, nobody can freeze). */
async function newMintInstructions(
  input: PoolSetupInput,
  mint: KeyPairSigner,
): Promise<Instruction[]> {
  const space = BigInt(getMintSize());
  const lamports = await input.rpc.getMinimumBalanceForRentExemption(space).send();
  return [
    getCreateAccountInstruction({
      payer: input.admin,
      newAccount: mint,
      lamports,
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint: mint.address,
      decimals: POOL_DEFAULTS.decimals,
      mintAuthority: input.admin.address,
      freezeAuthority: null,
    }),
  ];
}

/**
 * One transaction: (the mint, when `newMint` is given,) the pool and its vault,
 * and the vault funding. The admin is the mint authority either way.
 */
async function createPool(
  input: PoolSetupInput,
  expected: PoolState,
  vault: Address,
  newMint: KeyPairSigner | undefined,
): Promise<void> {
  const { admin } = input;
  await sendInstructions(input, admin, [
    ...(newMint === undefined ? [] : await newMintInstructions(input, newMint)),
    await getCreatePoolInstructionAsync({
      admin,
      mint: expected.mint,
      poolId: input.poolId,
      credential: expected.credential,
      schema: expected.schema,
      params: expected.params,
    }),
    getMintToInstruction({
      mint: expected.mint,
      token: vault,
      mintAuthority: admin,
      amount: POOL_DEFAULTS.vaultFunding,
    }),
  ]);
}
