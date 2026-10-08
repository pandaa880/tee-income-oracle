/**
 * `deployments/<cluster>.json`: the public addresses of one cluster. Several
 * scripts write parts of it (`sas:setup`, `pool:setup`, `enclave:rotate`), so
 * each one merges its keys into the file instead of replacing it.
 */
import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Address, address } from '@solana/kit';
import { OpsError } from './errors.ts';

export type DeploymentFile = Record<string, unknown>;

/** Shallow merge: `update` wins, keys it doesn't name are kept. */
export function mergeDeployment(
  existing: DeploymentFile | null,
  update: DeploymentFile,
): DeploymentFile {
  return { ...existing, ...update };
}

/** The file's JSON object, or null if there is no file. */
export async function readDeployment(path: string): Promise<DeploymentFile | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error(`${path} is not a JSON object`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Writes a temporary file next to `path`, then renames it over `path`, so a
 * crash or full disk never leaves a truncated deployment file behind.
 */
export async function writeDeployment(path: string, value: DeploymentFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** A deployment write takes milliseconds; a lock older than this is a crashed writer's. */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

/**
 * Read, merge `update` in, write back, holding `<path>.lock` for the whole
 * read-merge-write. Several scripts write the same file (`sas:setup`,
 * `pool:setup`, `enclave:rotate`); without the lock two of them can merge
 * into the same old snapshot, and the later write silently drops the other's
 * keys. A second writer waits for the lock.
 *
 * @throws OpsError `deployment_locked` if the lock stays held past `timeoutMs`.
 */
export async function updateDeployment(
  path: string,
  update: DeploymentFile,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const handle = await acquireFileLock(lock, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  try {
    await writeDeployment(path, mergeDeployment(await readDeployment(path), update));
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

/** Creates `lock` exclusively, retrying while another writer holds it. */
async function acquireFileLock(lock: string, timeoutMs: number): Promise<FileHandle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await open(lock, 'wx');
    } catch (error) {
      const held = error instanceof Error && 'code' in error && error.code === 'EEXIST';
      if (!held) throw error;
      if (Date.now() >= deadline) {
        throw new OpsError(
          'deployment_locked',
          `${lock} held for over ${timeoutMs} ms: if no ops script is running, a writer crashed: delete the file`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** An address stored under `key`, or undefined if absent. @throws if it isn't a valid address. */
export function optionalAddress(file: DeploymentFile | null, key: string): Address | undefined {
  const value = file?.[key];
  return typeof value === 'string' ? address(value) : undefined;
}

/** @throws OpsError `missing_deployment` naming the key (and the script that writes it). */
export function requiredAddress(file: DeploymentFile | null, key: string, writer: string): Address {
  const value = optionalAddress(file, key);
  if (value === undefined) {
    throw new OpsError(
      'missing_deployment',
      `deployment file has no "${key}": run ${writer} first`,
    );
  }
  return value;
}

/** `pools[].address`, in file order. */
export function poolAddresses(file: DeploymentFile | null): Address[] {
  const pools = file?.['pools'];
  if (!Array.isArray(pools)) return [];
  return pools.flatMap((pool: unknown) => {
    const value = isRecord(pool) ? pool['address'] : undefined;
    return typeof value === 'string' ? [address(value)] : [];
  });
}
