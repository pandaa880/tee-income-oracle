// Usage: pnpm --filter @tio/ops e2e:devnet -- --cluster devnet --gateway https://<gateway host>
// Local only (never CI). Reads credential, schema, mint and pools[0] from
// deployments/<cluster>.json; the admin wallet pays borrow/repay fees. Exit 1 on any FAIL.
import type { Address } from '@solana/kit';
import { chainClients, cliOptions, deploymentPath, readKeypair, runCli } from './cli.ts';
import { parseCluster } from './cluster.ts';
import { loadConfig } from './config.ts';
import { poolAddresses, readDeployment, requiredAddress } from './deployments.ts';
import { runE2e } from './e2e-devnet.ts';

function firstPool(deployment: Record<string, unknown> | null): Address {
  const [pool] = poolAddresses(deployment);
  if (pool === undefined) throw new Error('deployment file has no pools: run pool:setup first');
  return pool;
}

async function main(): Promise<void> {
  const options = cliOptions(['cluster', 'gateway']);
  const cluster = parseCluster(options.cluster);
  const gatewayUrl = (options.gateway ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(gatewayUrl)) throw new Error('--gateway must be an http(s) URL');
  const config = loadConfig(process.env);
  const deployment = await readDeployment(deploymentPath(cluster));
  const passed = await runE2e({
    ...chainClients(config),
    gatewayUrl,
    admin: await readKeypair(config.adminKeypairPath),
    credential: requiredAddress(deployment, 'credential', 'sas:setup'),
    schema: requiredAddress(deployment, 'schema', 'sas:setup'),
    mint: requiredAddress(deployment, 'mint', 'pool:setup'),
    pool: firstPool(deployment),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  if (!passed) process.exitCode = 1;
}

runCli(main);
