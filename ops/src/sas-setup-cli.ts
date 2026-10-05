// Usage: pnpm --filter @tio/ops sas:setup -- --cluster localnet|devnet
// Reads SOLANA_RPC_URL, SOLANA_WS_URL, ADMIN_KEYPAIR, ORACLE_PROGRAM_ID (see ops/README.md).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  type KeyPairSigner,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
} from '@solana/kit';
import { z } from 'zod';
import { parseCluster } from './cluster.ts';
import { loadConfig } from './config.ts';
import { runSasSetup } from './sas-setup.ts';

const KeypairFileSchema = z.array(z.number().int().min(0).max(255)).length(64);

async function readKeypair(path: string): Promise<KeyPairSigner> {
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

async function main(): Promise<void> {
  // pnpm forwards a literal `--` separator; accept both `sas:setup --cluster x` and `sas:setup -- --cluster x`.
  const argv = process.argv.slice(2);
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const { values } = parseArgs({ args, options: { cluster: { type: 'string' } } });
  const cluster = parseCluster(values.cluster);
  const config = loadConfig(process.env);
  const admin = await readKeypair(config.adminKeypairPath);
  // runSasSetup checks the RPC's genesis hash against `cluster` before anything else.
  const { created, deployment } = await runSasSetup({
    rpc: createSolanaRpc(config.rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(config.wsUrl),
    admin,
    oracleProgramId: config.oracleProgramId,
    cluster,
  });

  const out = new URL(`../../deployments/${cluster}.json`, import.meta.url);
  await mkdir(new URL('.', out), { recursive: true });
  await writeFile(out, `${JSON.stringify(deployment, null, 2)}\n`);
  const summary = created.length > 0 ? `created ${created.join(', ')}` : 'ok, nothing to create';
  process.stdout.write(`${summary}\nwrote ${out.pathname}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
