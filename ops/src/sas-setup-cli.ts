// Usage: pnpm --filter @tio/ops sas:setup -- --cluster localnet|devnet
// Reads SOLANA_RPC_URL, SOLANA_WS_URL, ADMIN_KEYPAIR, ORACLE_PROGRAM_ID (see ops/README.md).
import { chainClients, cliOptions, deploymentPath, readKeypair, runCli } from './cli.ts';
import { parseCluster } from './cluster.ts';
import { loadConfig } from './config.ts';
import { updateDeployment } from './deployments.ts';
import { runSasSetup } from './sas-setup.ts';

async function main(): Promise<void> {
  const cluster = parseCluster(cliOptions(['cluster']).cluster);
  const config = loadConfig(process.env);
  const admin = await readKeypair(config.adminKeypairPath);
  // runSasSetup checks the RPC's genesis hash against `cluster` before anything else.
  const { created, deployment } = await runSasSetup({
    ...chainClients(config),
    admin,
    oracleProgramId: config.oracleProgramId,
    cluster,
  });

  // Merge: pool:setup and enclave:rotate add their own keys to the same file.
  const out = deploymentPath(cluster);
  await updateDeployment(out, deployment);
  const summary = created.length > 0 ? `created ${created.join(', ')}` : 'ok, nothing to create';
  process.stdout.write(`${summary}\nwrote ${out}\n`);
}

runCli(main);
