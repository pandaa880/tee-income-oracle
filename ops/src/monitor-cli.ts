// Usage: pnpm --filter @tio/ops monitor:devnet -- --gateway https://<gateway host> --enclave-ip <ipv4>
//          --oyster-job <0x… job id> --owner <0x… job owner> [--out <dir>]
// Read-only health check of the devnet demo: no keys. Prints the report; with --out also writes
// <dir>/report.md and <dir>/status (ok | warn | fail) for the monitor workflow. Exit 1 on fail.
// Env (optional): SOLANA_RPC_URL (default public devnet), ARBITRUM_RPC_URL, OYSTER_INDEXER_URL.
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { cliOptions, runCli } from './cli.ts';
import { evaluate, overall, renderReport } from './monitor.ts';
import { runProbes } from './monitor-probes.ts';

const DEFAULTS = {
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  ARBITRUM_RPC_URL: 'https://arb1.arbitrum.io/rpc',
  OYSTER_INDEXER_URL: 'https://indexer.oyster.marlin.org/graphql',
} as const;

const JOB_ID = /^0x[0-9a-fA-F]{1,64}$/;
const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const env = (name: keyof typeof DEFAULTS): string => process.env[name] || DEFAULTS[name];

async function main(): Promise<void> {
  const options = cliOptions(['gateway', 'enclave-ip', 'oyster-job', 'owner', 'out']);
  const gatewayUrl = (options.gateway ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(gatewayUrl)) throw new Error('--gateway must be an http(s) URL');
  const enclaveIp = options['enclave-ip'] ?? '';
  if (isIP(enclaveIp) !== 4) throw new Error('--enclave-ip must be an IPv4 address');
  const oysterJobId = options['oyster-job'] ?? '';
  if (!JOB_ID.test(oysterJobId)) throw new Error('--oyster-job must be a 0x-prefixed hex job id');
  const owner = options.owner ?? '';
  if (!ETH_ADDRESS.test(owner)) throw new Error('--owner must be a 0x-prefixed 20-byte address');

  const probes = await runProbes({
    gatewayUrl,
    enclaveIp,
    oysterJobId,
    solanaRpcUrl: env('SOLANA_RPC_URL'),
    arbitrumRpcUrl: env('ARBITRUM_RPC_URL'),
    indexerUrl: env('OYSTER_INDEXER_URL'),
  });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const checks = evaluate(probes, now, owner);
  const status = overall(checks);
  const report = renderReport(checks, now);
  process.stdout.write(report);
  if (options.out !== undefined) {
    await mkdir(options.out, { recursive: true });
    await writeFile(join(options.out, 'report.md'), report);
    await writeFile(join(options.out, 'status'), `${status}\n`);
  }
  if (status === 'fail') process.exitCode = 1;
}

runCli(main);
