/**
 * Entry point of the live sandbox bank: `node src/service/main.ts`.
 * Configuration comes from the environment (see `config.ts`); a bad or
 * unpinned key stops the process before it listens.
 */

import { randomBytes } from 'node:crypto';

import { serve } from '@hono/node-server';

import { createRpcRegistry, createSolanaRegistryRpc } from '../chain/registry.ts';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function main(): void {
  const config = loadConfig(process.env);
  const registry = createRpcRegistry({
    rpc: createSolanaRegistryRpc(config.rpcUrl),
    programId: config.programId,
    now,
  });
  const app = createApp(
    {
      aa: config.aa,
      fip: config.fip,
      registry,
      now,
      random: (n) => new Uint8Array(randomBytes(n)),
    },
    config.token === undefined ? {} : { token: config.token },
  );
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    const caller = config.token === undefined ? 'no token, local only' : 'bearer token required';
    process.stdout.write(
      `sandbox-bank listening on :${info.port} (oracle ${config.programId}; ${caller})\n`,
    );
  });
  // PID 1 in the container: stop on `docker stop` instead of waiting for SIGKILL.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

try {
  main();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`sandbox-bank: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
