/**
 * `deployments/<cluster>.json`: the public addresses of one cluster. Several
 * scripts write parts of it (`sas:setup`, `pool:setup`, `enclave:rotate`), so
 * each one merges its keys into the file instead of replacing it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

export async function writeDeployment(path: string, value: DeploymentFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read, merge `update` in, write back. */
export async function updateDeployment(path: string, update: DeploymentFile): Promise<void> {
  await writeDeployment(path, mergeDeployment(await readDeployment(path), update));
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
