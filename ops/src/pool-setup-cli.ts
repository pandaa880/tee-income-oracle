// Usage: pnpm --filter @tio/ops pool:setup -- --cluster localnet|devnet
// Run after oracle:init and sas:setup (reads credential + schema from
// deployments/<cluster>.json). The new pool approves the registry entries active now;
// enclave:rotate keeps it current afterwards.
import { readFile } from 'node:fs/promises';
import { chainClients, cliOptions, deploymentPath, readKeypair, repoPath, runCli } from './cli.ts';
import { assertCluster, parseCluster } from './cluster.ts';
import { loadConfig } from './config.ts';
import { runPoolSetup } from './pool-setup.ts';
import { activeIds, readRegistry } from './registry.ts';

/** The default scoring policy's hash (sha256 of its JCS bytes, written by gen:vectors). */
async function defaultPolicyHash(): Promise<Uint8Array> {
  const hex = (await readFile(repoPath('test-vectors/policy/default.hash'), 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('test-vectors/policy/default.hash is not 32 bytes of hex');
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function main(): Promise<void> {
  const cluster = parseCluster(cliOptions(['cluster']).cluster);
  const config = loadConfig(process.env);
  const clients = chainClients(config);
  // Before the registry read below: never read a cluster other than the one named.
  await assertCluster({ ...clients, cluster });
  const result = await runPoolSetup({
    ...clients,
    cluster,
    admin: await readKeypair(config.adminKeypairPath),
    deploymentPath: deploymentPath(cluster),
    policyHash: await defaultPolicyHash(),
    approvedIds: activeIds(await readRegistry(clients)),
  });
  process.stdout.write(
    `${result.created ? 'created' : 'ok, exists:'} pool ${result.pool}\nmint ${result.mint}\nvault ${result.vault}\n`,
  );
}

runCli(main);
