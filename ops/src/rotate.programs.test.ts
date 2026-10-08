// `runRotate` against the real oracle, demo-pool and SAS programs on an embedded surfnet, with
// fake Oyster ports (no network, no oyster-cvm). Needs `anchor build`. One surfnet per file;
// tests build on each other in order: rotation 1, 2, 3 (re-run), then the failure cases.
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Address, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { type PoolParams, fetchMaybePool } from '@tio/demo-pool-client';
import {
  ENCLAVE_ENTRY_DISCRIMINATOR,
  ORACLE_PROGRAM_ADDRESS,
  fetchMaybeConfig,
  fetchMaybeEnclaveEntry,
  findConfigPda,
  findEnclaveEntryPda,
} from '@tio/oracle-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPoolSetup } from './pool-setup.ts';
import { OpsError } from './errors.ts';
import { type RotatePorts, runRotate } from './rotate.ts';
import { runSasSetup } from './sas-setup.ts';
import {
  type OpsChain,
  countingRpc,
  initializeOracleDirect,
  rejection,
  startOpsChain,
} from './testing/chain.ts';
import {
  type FakeEnclave,
  PLACEHOLDER_COMPOSE,
  composeWithDigest,
  computeImageIdOutput,
  fakeAttestationHex,
  fakeEnclave,
  verifyOutput,
} from './testing/oyster-fake.ts';

const KIND_OYSTER_IMAGE_ID = 1;
const COMPOSE = composeWithDigest('ab'.repeat(32));

let chain: OpsChain;
let dir: string;
let deploymentPath: string;
let archiveDir: string;
let pool: Address;

type PortCalls = { verify: { hexFile: string; imageIdHex: string }[]; fetched: number };

/** Fake ports for `enclave`. `overrides` replaces single ports to simulate a failure. */
function portsFor(
  enclave: FakeEnclave,
  seed: number,
  overrides: Partial<RotatePorts> = {},
): { ports: RotatePorts; calls: PortCalls } {
  const calls: PortCalls = { verify: [], fetched: 0 };
  const ports: RotatePorts = {
    composeText: async () => COMPOSE,
    computeImageId: async () => computeImageIdOutput(enclave.imageIdHex),
    fetchAttestationHex: async () => {
      calls.fetched += 1;
      return fakeAttestationHex(seed);
    },
    verify: async (hexFile, imageIdHex) => {
      calls.verify.push({ hexFile, imageIdHex });
      return verifyOutput({
        enclavePublicKeyHex: enclave.publicKeyHex,
        imageIdHex: enclave.imageIdHex,
      });
    },
    enclaveInfo: async () => ({ attester_address: enclave.attesterHex }),
    ...overrides,
  };
  return { ports, calls };
}

function rotate(ports: RotatePorts, rpc = chain.rpc): ReturnType<typeof runRotate> {
  return runRotate({
    cluster: 'localnet',
    rpc,
    rpcSubscriptions: chain.rpcSubscriptions,
    admin: chain.admin,
    deploymentPath,
    archiveDir,
    ports,
  });
}

const sha256Hex = (hex: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(Buffer.from(hex, 'hex')).digest());

async function entryAt(id: number) {
  const [address] = await findEnclaveEntryPda({ measurementId: id });
  return fetchMaybeEnclaveEntry(chain.rpc, address);
}

async function nextMeasurementId(): Promise<number> {
  const [address] = await findConfigPda();
  const config = await fetchMaybeConfig(chain.rpc, address);
  if (!config.exists) throw new Error('oracle not initialized');
  return config.data.nextMeasurementId;
}

async function approvedBitmap(): Promise<Uint8Array> {
  const account = await fetchMaybePool(chain.rpc, pool);
  if (!account.exists) throw new Error('pool missing');
  return new Uint8Array(account.data.params.approvedMeasurements);
}

function bitmapOf(...ids: number[]): Uint8Array {
  const bitmap = new Uint8Array(32);
  for (const id of ids) {
    bitmap[Math.floor(id / 8)] = (bitmap[Math.floor(id / 8)] ?? 0) | (1 << (id % 8));
  }
  return bitmap;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function poolParams(): Promise<PoolParams> {
  const account = await fetchMaybePool(chain.rpc, pool);
  if (!account.exists) throw new Error('pool missing');
  return account.data.params;
}

/** The archived document for `id` hashes to the doc hash stored on chain. */
async function expectArchiveMatchesEntry(id: number): Promise<void> {
  const archived = (await readFile(join(archiveDir, `attestation-${id}.hex`), 'utf8')).trim();
  const entry = await entryAt(id);
  expect(entry.exists && new Uint8Array(entry.data.attestationDocHash)).toEqual(
    sha256Hex(archived),
  );
}

/** The same RPC, but every `sendTransaction` throws after it has really been sent. */
function lostConfirmationRpc(rpc: Rpc<SolanaRpcApi>): Rpc<SolanaRpcApi> {
  return new Proxy(rpc, {
    get(target, property, receiver) {
      if (property !== 'sendTransaction') return Reflect.get(target, property, receiver) as unknown;
      return (...args: Parameters<Rpc<SolanaRpcApi>['sendTransaction']>) => ({
        send: async (options?: { abortSignal?: AbortSignal }) => {
          await target.sendTransaction(...args).send(options);
          throw new Error('confirmation lost');
        },
      });
    },
  });
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function deploymentFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(deploymentPath, 'utf8')) as Record<string, unknown>;
}

/**
 * Runs `rotate`, expects a rejection, and asserts that no transaction was sent and the registry
 * and pool are unchanged (state after the third rotation).
 */
async function expectRejected(ports: RotatePorts): Promise<unknown> {
  const counted = countingRpc(chain.rpc);
  const failure = await rejection(rotate(ports, counted.rpc));
  expect(failure).toBeInstanceOf(Error);
  expect(counted.sent()).toBe(0);
  expect(await nextMeasurementId()).toBe(2);
  expect((await entryAt(2)).exists).toBe(false);
  expect(await approvedBitmap()).toEqual(bitmapOf(1));
  return failure;
}

const ONE = fakeEnclave(1);
const TWO = fakeEnclave(2);
const THREE = fakeEnclave(3);

describe('runRotate on surfpool', () => {
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
    dir = await mkdtemp(join(tmpdir(), 'rotate-'));
    deploymentPath = join(dir, 'localnet.json');
    // The archive directory does not exist yet: rotate must create it.
    archiveDir = join(dir, 'archive', 'localnet');
    await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
    const created = await runPoolSetup({
      cluster: 'localnet',
      rpc: chain.rpc,
      rpcSubscriptions: chain.rpcSubscriptions,
      admin: chain.admin,
      deploymentPath,
      policyHash: new Uint8Array(32).fill(0x81),
      approvedIds: [],
    });
    pool = created.pool;
  });

  afterAll(async () => {
    chain.surfnet.stop();
    await rm(dir, { recursive: true, force: true });
  });

  describe('first rotation', () => {
    let result: Awaited<ReturnType<typeof runRotate>>;
    let calls: PortCalls;

    beforeAll(async () => {
      const fake = portsFor(ONE, 1);
      calls = fake.calls;
      result = await rotate(fake.ports);
    });

    it('registers_entry_zero_and_approves_it_in_the_pool', () => {
      expect(result).toMatchObject({
        measurementId: 0,
        registered: true,
        revoked: [],
        poolsUpdated: [pool],
      });
      expect(result.attestationFile.endsWith('attestation-0.hex')).toBe(true);
    });

    it('verifies_the_pending_file_in_the_archive_dir_against_the_computed_image_id', () => {
      expect(calls.verify).toHaveLength(1);
      expect(calls.verify[0]?.hexFile).toBe(join(archiveDir, 'attestation-pending.hex'));
      expect(calls.verify[0]?.imageIdHex).toBe(ONE.imageIdHex);
    });

    it('stores_an_active_oyster_entry_with_image_id_attester_and_doc_hash', async () => {
      const entry = await entryAt(0);
      expect(entry.exists).toBe(true);
      if (!entry.exists) return;
      expect(new Uint8Array(entry.data.discriminator)).toEqual(
        new Uint8Array(ENCLAVE_ENTRY_DISCRIMINATOR),
      );
      expect(entry.data.measurementKind).toBe(KIND_OYSTER_IMAGE_ID);
      expect(Buffer.from(entry.data.measurement).toString('hex')).toBe(ONE.imageIdHex);
      expect(new Uint8Array(entry.data.attester)).toEqual(ONE.attester);
      expect(new Uint8Array(entry.data.attestationDocHash)).toEqual(
        sha256Hex(fakeAttestationHex(1)),
      );
      expect(entry.data.revokedAt).toBe(0n);
    });

    it('advances_next_measurement_id_and_sets_only_bit_zero_in_the_pool', async () => {
      expect(await nextMeasurementId()).toBe(1);
      expect(await approvedBitmap()).toEqual(bitmapOf(0));
    });

    it('renames_the_pending_file_to_the_numbered_archive', async () => {
      expect(await exists(join(archiveDir, 'attestation-pending.hex'))).toBe(false);
      expect(await exists(join(archiveDir, 'attestation-0.hex'))).toBe(true);
    });

    it('merges_the_enclave_into_the_deployment_keeping_pools_and_mint', async () => {
      const deployment = await deploymentFile();
      const enclaves = deployment['enclaves'] as Record<string, unknown>[];
      expect(enclaves).toHaveLength(1);
      expect(enclaves[0]?.['measurement_id']).toBe(0);
      expect(String(enclaves[0]?.['image_id']).toLowerCase()).toContain(ONE.imageIdHex);
      expect(String(enclaves[0]?.['attester']).toLowerCase()).toContain(ONE.attesterHex.slice(2));
      expect(String(enclaves[0]?.['attestation_file'])).toMatch(/attestation-0\.hex$/);
      expect(deployment['pools']).toEqual([{ address: pool, pool_id: 0 }]);
      expect(typeof deployment['mint']).toBe('string');
      expect(typeof deployment['credential']).toBe('string');
    });
  });

  describe('second rotation with a new key', () => {
    let result: Awaited<ReturnType<typeof runRotate>>;
    let paramsBefore: PoolParams;

    beforeAll(async () => {
      paramsBefore = await poolParams();
      // The enclave reports its address in upper case: the comparison is case-insensitive.
      const upper = `0x${TWO.attesterHex.slice(2).toUpperCase()}`;
      result = await rotate(
        portsFor(TWO, 2, { enclaveInfo: async () => ({ attester_address: upper }) }).ports,
      );
    });

    it('registers_entry_one_and_revokes_entry_zero', () => {
      expect(result).toMatchObject({
        measurementId: 1,
        registered: true,
        revoked: [0],
        poolsUpdated: [pool],
      });
    });

    it('leaves_entry_zero_revoked_and_entry_one_active', async () => {
      const zero = await entryAt(0);
      const one = await entryAt(1);
      expect(zero.exists && zero.data.revokedAt > 0n).toBe(true);
      expect(one.exists && one.data.revokedAt).toBe(0n);
      expect(one.exists && new Uint8Array(one.data.attester)).toEqual(TWO.attester);
    });

    it('moves_the_pool_from_bit_zero_to_bit_one_only', async () => {
      expect(await approvedBitmap()).toEqual(bitmapOf(1));
    });

    it('keeps_every_other_pool_param', async () => {
      const after = await poolParams();
      expect({ ...after, approvedMeasurements: null }).toEqual({
        ...paramsBefore,
        approvedMeasurements: null,
      });
    });

    it('appends_the_second_enclave_to_the_deployment', async () => {
      const enclaves = (await deploymentFile())['enclaves'] as Record<string, unknown>[];
      expect(enclaves.map((e) => e['measurement_id'])).toEqual([0, 1]);
    });
  });

  describe('third run with the same enclave', () => {
    it('registers_revokes_and_updates_nothing_and_sends_no_transaction', async () => {
      const counted = countingRpc(chain.rpc);
      const result = await rotate(portsFor(TWO, 2).ports, counted.rpc);
      expect(result).toMatchObject({
        measurementId: 1,
        registered: false,
        revoked: [],
        poolsUpdated: [],
      });
      expect(counted.sent()).toBe(0);
      expect(await nextMeasurementId()).toBe(2);
      expect(await approvedBitmap()).toEqual(bitmapOf(1));
      const enclaves = (await deploymentFile())['enclaves'] as unknown[];
      expect(enclaves).toHaveLength(2);
    });

    it('drops_the_fresh_pending_file_and_keeps_the_archive_that_matches_the_chain', async () => {
      expect(await exists(join(archiveDir, 'attestation-pending.hex'))).toBe(false);
      await expectArchiveMatchesEntry(1);
    });
  });

  describe('failures before sending', () => {
    it('refuses_a_placeholder_compose_before_doing_anything', async () => {
      const { ports, calls } = portsFor(THREE, 3, { composeText: async () => PLACEHOLDER_COMPOSE });
      const failure = await expectRejected(ports);
      expect(failure).toBeInstanceOf(OpsError);
      expect(failure).toMatchObject({ code: 'placeholder_compose' });
      expect(calls.fetched).toBe(0);
      expect(calls.verify).toHaveLength(0);
    });

    it('rejects_an_attester_that_differs_from_the_enclave_info_and_keeps_the_pending_file', async () => {
      const { ports } = portsFor(THREE, 3, {
        enclaveInfo: async () => ({ attester_address: TWO.attesterHex }),
      });
      const failure = await expectRejected(ports);
      expect(failure).toBeInstanceOf(OpsError);
      expect(failure).toMatchObject({ code: 'attester_mismatch' });
      expect(await exists(join(archiveDir, 'attestation-pending.hex'))).toBe(true);
    });

    it('rejects_a_verified_image_id_that_differs_from_the_computed_one', async () => {
      const { ports } = portsFor(THREE, 3, {
        verify: async () =>
          verifyOutput({
            enclavePublicKeyHex: THREE.publicKeyHex,
            imageIdHex: TWO.imageIdHex,
          }),
      });
      const failure = await expectRejected(ports);
      expect(failure).toBeInstanceOf(OpsError);
      expect(failure).toMatchObject({ code: 'image_id_mismatch' });
    });

    it('rejects_verify_output_without_the_success_line', async () => {
      const { ports } = portsFor(THREE, 3, {
        verify: async () =>
          verifyOutput({
            enclavePublicKeyHex: THREE.publicKeyHex,
            imageIdHex: THREE.imageIdHex,
            omitSuccess: true,
          }),
      });
      expect(await expectRejected(ports)).toMatchObject({ code: 'verify_failed' });
    });

    it('rejects_verify_output_with_an_error_line', async () => {
      const { ports } = portsFor(THREE, 3, {
        verify: async () =>
          verifyOutput({
            enclavePublicKeyHex: THREE.publicKeyHex,
            imageIdHex: THREE.imageIdHex,
            extraLines: ['2026-10-08T10:00:00.123456Z ERROR oyster_cvm::commands::verify: bad'],
          }),
      });
      expect(await expectRejected(ports)).toMatchObject({ code: 'verify_failed' });
    });

    it('rejects_when_fetching_the_attestation_fails', async () => {
      const { ports } = portsFor(THREE, 3, {
        fetchAttestationHex: async () => {
          throw new Error('connection refused');
        },
      });
      expect(await expectRejected(ports)).toMatchObject({ code: 'attestation_fetch_failed' });
    });

    it('rejects_when_the_image_id_cannot_be_computed', async () => {
      const { ports } = portsFor(THREE, 3, { computeImageId: async () => 'no image id here' });
      expect(await expectRejected(ports)).toMatchObject({ code: 'image_id_unreadable' });
    });

    it('rejects_when_the_enclave_info_call_fails', async () => {
      const { ports } = portsFor(THREE, 3, {
        enclaveInfo: async () => {
          throw new Error('503');
        },
      });
      expect(await expectRejected(ports)).toMatchObject({ code: 'enclave_info_failed' });
    });
  });

  describe('a run that registered and then failed before archiving', () => {
    const FOUR = fakeEnclave(4);
    let failure: unknown;

    beforeAll(async () => {
      // The transaction lands, but the client sees an error (a dropped confirmation).
      failure = await rejection(rotate(portsFor(FOUR, 4).ports, lostConfirmationRpc(chain.rpc)));
      await waitFor(async () => (await nextMeasurementId()) === 3);
    });

    it('failed_after_the_send', () => {
      expect(failure).toBeInstanceOf(Error);
    });

    it('had_registered_entry_two_on_chain', async () => {
      expect(await nextMeasurementId()).toBe(3);
      const entry = await entryAt(2);
      expect(entry.exists && new Uint8Array(entry.data.attestationDocHash)).toEqual(
        sha256Hex(fakeAttestationHex(4)),
      );
    });

    it('re_run_promotes_the_committed_pending_file_instead_of_overwriting_it', async () => {
      // The enclave now serves a fresh document (seed 5); the archive must still hold seed 4's.
      const result = await rotate(
        portsFor(FOUR, 5, { fetchAttestationHex: async () => fakeAttestationHex(5) }).ports,
      );
      expect(result).toMatchObject({ measurementId: 2, registered: false });
      await expectArchiveMatchesEntry(2);
      expect(await exists(join(archiveDir, 'attestation-pending.hex'))).toBe(false);
      const enclaves = (await deploymentFile())['enclaves'] as Record<string, unknown>[];
      expect(enclaves.map((e) => e['measurement_id'])).toEqual([0, 1, 2]);
    });
  });

  describe('a stale archive at the next id', () => {
    it('refuses_with_archive_conflict_before_sending_and_leaves_the_file', async () => {
      // Left by an earlier deployment whose registry counter also reached 3.
      const stale = join(archiveDir, 'attestation-3.hex');
      await writeFile(stale, 'ab'.repeat(32));
      const counted = countingRpc(chain.rpc);
      const failure = await rejection(rotate(portsFor(fakeEnclave(6), 6).ports, counted.rpc));
      expect(failure).toBeInstanceOf(OpsError);
      expect(failure).toMatchObject({ code: 'archive_conflict' });
      expect(counted.sent()).toBe(0);
      expect(await nextMeasurementId()).toBe(3);
      expect(await readFile(stale, 'utf8')).toBe('ab'.repeat(32));
    });
  });
});
