// Usage: pnpm --filter @tio/ops oracle:init -- --cluster localnet|devnet
// The ADMIN_KEYPAIR wallet must be the oracle's upgrade authority; it also becomes the
// registry admin. Env: see ops/README.md.
import { chainClients, cliOptions, readKeypair, runCli } from './cli.ts';
import { parseCluster } from './cluster.ts';
import { loadConfig } from './config.ts';
import { runOracleInit } from './oracle-init.ts';

async function main(): Promise<void> {
  const cluster = parseCluster(cliOptions(['cluster']).cluster);
  const config = loadConfig(process.env);
  const admin = await readKeypair(config.adminKeypairPath);
  const { created } = await runOracleInit({
    ...chainClients(config),
    cluster,
    authority: admin,
    admin: admin.address,
  });
  process.stdout.write(
    created ? `created oracle config, admin ${admin.address}\n` : 'ok, config exists\n',
  );
}

runCli(main);
