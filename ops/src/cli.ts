/** Shared plumbing for the ops CLIs: arguments, keypair files, deployment paths, exit codes. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type KeyPairSigner,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
} from '@solana/kit';
import { z } from 'zod';
import type { Cluster } from './cluster.ts';
import type { Config } from './config.ts';
import type { ChainClients } from './send.ts';

const KeypairFileSchema = z.array(z.number().int().min(0).max(255)).length(64);

/** Repo-relative paths, resolved from this file so the CLIs work from any cwd. */
export const repoPath = (relative: string): string =>
  fileURLToPath(new URL(`../../${relative}`, import.meta.url));

export const deploymentPath = (cluster: Cluster): string => repoPath(`deployments/${cluster}.json`);

/**
 * Named string options. pnpm forwards a literal `--` separator, so both
 * `script --cluster x` and `script -- --cluster x` work.
 */
export function cliOptions<K extends string>(names: readonly K[]): Partial<Record<K, string>> {
  const argv = process.argv.slice(2);
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options = Object.fromEntries(names.map((n) => [n, { type: 'string' as const }]));
  const { values } = parseArgs({ args, options });
  const picked: Partial<Record<K, string>> = {};
  for (const name of names) {
    const value: unknown = values[name];
    if (typeof value === 'string') picked[name] = value;
  }
  return picked;
}

export async function readKeypair(path: string): Promise<KeyPairSigner> {
  // Never let the file contents reach an error message: it is a secret key,
  // and V8's JSON SyntaxError quotes a slice of its input.
  const notAKeypair = new Error(`${path} is not a 64-byte Solana keypair file`);
  const text = await readFile(path, 'utf8'); // I/O errors carry path + errno, no content
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw notAKeypair;
  }
  const parsed = KeypairFileSchema.safeParse(json);
  if (!parsed.success) throw notAKeypair;
  return createKeyPairSignerFromBytes(new Uint8Array(parsed.data));
}

export function chainClients(config: Config): ChainClients {
  return {
    rpc: createSolanaRpc(config.rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(config.wsUrl),
  };
}

/** Runs a CLI body; prints only the error message (never env or key material) and exits 1. */
export function runCli(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
