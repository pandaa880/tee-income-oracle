/**
 * `enclave:rotate`: registers the running Oyster enclave's attester key in
 * the oracle registry (FORMATS §13), approves it in every demo pool (§14)
 * and revokes the entries it replaces.
 *
 * Why this order of checks: the attester key is what the oracle trusts, and
 * the only evidence that it lives in our enclave is the Nitro attestation.
 * So the attestation is fetched once and archived, and `oyster-cvm verify`
 * checks *that file* (AWS root chain, freshness, and the image id we compute
 * from our own compose file). The key we register is the one the verified
 * document attests, and `sha256` of the same bytes goes on chain, so anyone
 * can re-verify the archived file later. `/v1/info` is only a cross-check
 * that the enclave answering on :8080 is the one that was attested.
 *
 * The archive is evidence for an on-chain hash, so it is never overwritten:
 * a run that registered but failed before archiving leaves the document in
 * the pending file, and the next run promotes it before fetching a new one.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Address, Instruction, KeyPairSigner } from '@solana/kit';
import { type PoolParams, fetchMaybePool, getUpdatePoolInstruction } from '@tio/demo-pool-client';
import {
  type EnclaveEntry,
  findEnclaveEntryPda,
  getRegisterEnclaveInstructionAsync,
  getRevokeEnclaveInstructionAsync,
} from '@tio/oracle-client';
import { type Cluster, assertCluster } from './cluster.ts';
import { isRecord, poolAddresses, readDeployment, updateDeployment } from './deployments.ts';
import { OpsError } from './errors.ts';
import { ethAddressFromPublicKey, toEthHex } from './eth-address.ts';
import { isPlaceholderCompose, parseImageId, parseVerifyOutput } from './oyster.ts';
import { type Registry, readRegistry } from './registry.ts';
import { type RotatePlan, planRotate } from './rotate-plan.ts';
import { type ChainClients, sendInstructions } from './send.ts';

/** FORMATS §13 `measurement_kind` 1: Oyster image id. */
const KIND_OYSTER_IMAGE_ID = 1;
const PENDING_FILE = 'attestation-pending.hex';

/** Everything outside the chain, injected so tests replace the network and the CLI. */
export type RotatePorts = {
  composeText(): Promise<string>;
  /** Raw output of `oyster-cvm compute-image-id`. */
  computeImageId(): Promise<string>;
  /** Body of `GET http://<ip>:1301/attestation/hex`. */
  fetchAttestationHex(): Promise<string>;
  /** Raw output of `oyster-cvm verify --attestation-hex-file <file> --image-id <id>`. */
  verify(hexFile: string, imageIdHex: string): Promise<string>;
  /** `GET http://<ip>:8080/v1/info`. */
  enclaveInfo(): Promise<{ attester_address: string }>;
};

export type RotateInput = ChainClients & {
  cluster: Cluster;
  /** Oracle registry admin and admin of every pool in the deployment file; pays. */
  admin: KeyPairSigner;
  deploymentPath: string;
  /** Where `attestation-<id>.hex` files are kept (`deployments/<cluster>/`). */
  archiveDir: string;
  ports: RotatePorts;
};

export type RotateResult = {
  measurementId: number;
  registered: boolean;
  revoked: number[];
  poolsUpdated: string[];
  attestationFile: string;
  /** Things the operator must look at (no pools listed, a missing archive). */
  warnings: string[];
};

type Attested = { imageId: Uint8Array; attester: Uint8Array; docHash: Uint8Array };

/** @throws OpsError; nothing is sent unless every check passes. */
export async function runRotate(input: RotateInput): Promise<RotateResult> {
  await assertCluster(input);
  const pendingFile = join(input.archiveDir, PENDING_FILE);
  // Promoting changes no chain state, so one registry read serves the whole run.
  const registry = await readRegistry(input);
  await promoteCommittedPending(input, pendingFile, registry);

  const attested = await attestedEnclave(input.ports, pendingFile);
  const pools = await readPools(input);
  const plan = planRotate({
    nextMeasurementId: registry.nextMeasurementId,
    entries: registry.entries.map((e) => ({
      measurementId: e.measurementId,
      measurement: new Uint8Array(e.measurement),
      attester: new Uint8Array(e.attester),
      revokedAt: e.revokedAt,
    })),
    pools: [...pools.values()].map(({ address, params }) => ({
      address,
      approvedMeasurements: new Uint8Array(params.approvedMeasurements),
    })),
    enclave: attested,
  });
  const attestationFile = archivePath(input, plan.measurementId);
  // Checked before sending: after the send, the pending file must be able to take this name.
  if (plan.register && (await exists(attestationFile))) {
    throw new OpsError(
      'archive_conflict',
      `${attestationFile} already exists for an id not yet registered (stale archive from an earlier deployment?)`,
    );
  }
  const instructions = await rotateInstructions(input.admin, plan, attested, pools);
  if (instructions.length > 0) await sendInstructions(input, input.admin, instructions);

  const warnings: string[] = [];
  if (pools.size === 0) warnings.push('no pools in the deployment file: none approves this id');
  if (plan.register) {
    await rename(pendingFile, attestationFile);
  } else {
    // A fresh document of an enclave registered earlier: its hash isn't on chain.
    await rm(pendingFile);
    if (!(await exists(attestationFile))) {
      warnings.push(
        `archive ${attestationFile} is missing for registered id ${plan.measurementId}`,
      );
    }
  }
  await recordEnclave(input, plan.measurementId, attested, attestationFile);
  return {
    measurementId: plan.measurementId,
    registered: plan.register,
    revoked: plan.revoke,
    poolsUpdated: plan.poolUpdates.map((p) => p.address),
    attestationFile,
    warnings,
  };
}

const archivePath = (input: RotateInput, measurementId: number): string =>
  join(input.archiveDir, `attestation-${measurementId}.hex`);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

const sha256OfHex = (hex: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(Buffer.from(hex, 'hex')).digest());

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * A pending file left by a run that registered and then failed holds the only
 * copy of an on-chain-hashed document: move it to its archive name (and record
 * the entry) before anything overwrites it. A pending file no entry vouches
 * for is from a run that stopped before sending; it is simply replaced.
 */
async function promoteCommittedPending(
  input: RotateInput,
  pendingFile: string,
  registry: Registry,
): Promise<void> {
  if (!(await exists(pendingFile))) return;
  const hash = sha256OfHex((await readFile(pendingFile, 'utf8')).trim());
  const entry = registry.entries.find((e) => sameBytes(new Uint8Array(e.attestationDocHash), hash));
  if (entry === undefined) return;
  const target = archivePath(input, entry.measurementId);
  if (await exists(target)) {
    // Trust an archive by content, not by name.
    const archived = sha256OfHex((await readFile(target, 'utf8')).trim());
    if (!sameBytes(archived, hash)) {
      throw new OpsError(
        'archive_conflict',
        `${target} does not hash to entry ${entry.measurementId}; the pending file holds the document that does`,
      );
    }
    await rm(pendingFile);
    return;
  }
  await rename(pendingFile, target);
  await recordEnclave(input, entry.measurementId, attestedOf(entry), target);
}

const attestedOf = (entry: EnclaveEntry): Attested => ({
  imageId: new Uint8Array(entry.measurement),
  attester: new Uint8Array(entry.attester),
  docHash: new Uint8Array(entry.attestationDocHash),
});

/** Fetch, archive and verify the attestation; returns what it vouches for. */
async function attestedEnclave(ports: RotatePorts, pendingFile: string): Promise<Attested> {
  if (isPlaceholderCompose(await ports.composeText())) {
    throw new OpsError('placeholder_compose', 'enclave/docker-compose.yml is still the template');
  }
  const computed = await wrap('image_id_unreadable', async () =>
    parseImageId(await ports.computeImageId()),
  );
  const hex = (await wrap('attestation_fetch_failed', () => ports.fetchAttestationHex())).trim();
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) {
    throw new OpsError('bad_attestation', 'attestation endpoint did not return hex');
  }
  await mkdir(dirname(pendingFile), { recursive: true });
  await writeFile(pendingFile, hex);

  const computedHex = Buffer.from(computed).toString('hex');
  const verified = await wrap('verify_failed', async () =>
    parseVerifyOutput(await ports.verify(pendingFile, computedHex)),
  );
  if (Buffer.from(verified.imageId).toString('hex') !== computedHex) {
    throw new OpsError('image_id_mismatch', 'attested image id differs from the compose file');
  }
  const attester = ethAddressFromPublicKey(verified.enclavePublicKey);
  const info = await wrap('enclave_info_failed', () => ports.enclaveInfo());
  const reported = info.attester_address.toLowerCase();
  if (reported !== toEthHex(attester)) {
    throw new OpsError(
      'attester_mismatch',
      `enclave reports ${reported}, attested ${toEthHex(attester)}`,
    );
  }
  return { imageId: computed, attester, docHash: sha256OfHex(hex) };
}

/** Runs `fn`, turning a failure into an OpsError with `code` (OpsErrors pass through). */
async function wrap<T>(code: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OpsError) throw error;
    throw new OpsError(code, error instanceof Error ? error.message : String(error));
  }
}

type ListedPool = { address: Address; params: PoolParams };

/** The pools listed in the deployment file (`pools[].address`) with their current params. */
async function readPools(input: RotateInput): Promise<Map<string, ListedPool>> {
  const pools = new Map<string, ListedPool>();
  for (const address of poolAddresses(await readDeployment(input.deploymentPath))) {
    const pool = await fetchMaybePool(input.rpc, address);
    if (!pool.exists) throw new OpsError('pool_missing', `pool ${address} does not exist`);
    pools.set(address, { address, params: pool.data.params });
  }
  return pools;
}

/** Register, then approve in each pool, then revoke: one atomic transaction. */
async function rotateInstructions(
  admin: KeyPairSigner,
  plan: RotatePlan,
  attested: Attested,
  pools: Map<string, ListedPool>,
): Promise<Instruction[]> {
  const instructions: Instruction[] = [];
  if (plan.register) {
    instructions.push(
      await getRegisterEnclaveInstructionAsync({
        admin,
        // Passed explicitly: the generated builder can't derive it (the seed is the
        // counter in Config, read above).
        enclaveEntry: (await findEnclaveEntryPda({ measurementId: plan.measurementId }))[0],
        measurementKind: KIND_OYSTER_IMAGE_ID,
        measurement: attested.imageId,
        attester: attested.attester,
        attestationDocHash: attested.docHash,
      }),
    );
  }
  for (const update of plan.poolUpdates) {
    const listed = pools.get(update.address);
    if (listed === undefined) throw new OpsError('pool_missing', `pool ${update.address} not read`);
    // update_pool replaces every param; only the bitmap changes.
    instructions.push(
      getUpdatePoolInstruction({
        admin,
        pool: listed.address,
        params: { ...listed.params, approvedMeasurements: update.approvedMeasurements },
      }),
    );
  }
  for (const measurementId of plan.revoke) {
    instructions.push(await getRevokeEnclaveInstructionAsync({ admin, measurementId }));
  }
  return instructions;
}

/**
 * Adds `{ measurement_id, image_id, attester, attestation_file }` to the
 * deployment's `enclaves`, once per id.
 */
async function recordEnclave(
  input: RotateInput,
  measurementId: number,
  attested: Attested,
  attestationFile: string,
): Promise<void> {
  const existing = (await readDeployment(input.deploymentPath))?.['enclaves'];
  const enclaves: unknown[] = Array.isArray(existing) ? existing : [];
  const record = {
    measurement_id: measurementId,
    image_id: Buffer.from(attested.imageId).toString('hex'),
    attester: toEthHex(attested.attester),
    // Relative to the deployment file, so the committed path works in any checkout.
    attestation_file: relative(dirname(input.deploymentPath), attestationFile),
  };
  const found = enclaves.find((e) => isRecord(e) && e['measurement_id'] === measurementId);
  if (found !== undefined) {
    // Same id, other enclave: a stale record from an earlier deployment of the registry.
    if (
      isRecord(found) &&
      found['attester'] === record.attester &&
      found['image_id'] === record.image_id
    ) {
      return;
    }
    throw new OpsError(
      'deployment_conflict',
      `enclaves[] already holds another enclave as id ${measurementId}`,
    );
  }
  await updateDeployment(input.deploymentPath, { enclaves: [...enclaves, record] });
}
