/**
 * Entry point of the gateway: `node src/main.ts`. Boot order (FORMATS §16):
 * config → enclave /v1/info → registry entry active with the enclave's
 * attester → FIU key registered with the bank → relayer balance → listen.
 * Any failure exits 1 before the port opens.
 */
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
} from '@solana/kit';

import { createApp } from './app.ts';
import { kitChain } from './chain.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { GatewayError } from './errors.ts';
import { createFiuKeyManager } from './fiu-key.ts';
import { createRateLimiter } from './rate-limit.ts';
import { checkEnclaveEntry } from './registry.ts';
import { createRelayer } from './relayer.ts';
import { createSessionStore } from './sessions.ts';
import { rpcSignal } from './timeouts.ts';
import { createBankClient, createEnclaveClient } from './upstream.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOW_BALANCE_LAMPORTS = 50_000_000n; // 0.05 SOL

const nowSecs = (): number => Math.floor(Date.now() / 1000);

async function relayerSigner(config: Config) {
  try {
    return await createKeyPairSignerFromBytes(config.relayerSecret);
  } catch {
    throw new ConfigError('RELAYER_KEYPAIR is not a valid Ed25519 keypair');
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, REPO_ROOT);
  const payer = await relayerSigner(config);
  const rpc = createSolanaRpc(config.rpcUrl);
  const enclave = createEnclaveClient(config.enclaveUrl);
  const bank = createBankClient(config.bankUrl, fetch, config.bankToken);

  const info = await enclave.info();
  await checkEnclaveEntry(rpc, config.measurementId, info.attester_address);
  const fiuKey = createFiuKeyManager({ enclave, bank, expectedAttester: info.attester_address });
  await fiuKey.ensureFresh();
  const { value: balance } = await rpc.getBalance(payer.address).send({ abortSignal: rpcSignal() });
  if (balance < LOW_BALANCE_LAMPORTS) {
    process.stderr.write(`gateway: warning: relayer ${payer.address} has ${balance} lamports\n`);
  }

  const app = createApp({
    enclave,
    bank,
    relayer: createRelayer({
      chain: kitChain(rpc, createSolanaRpcSubscriptions(config.wsUrl)),
      payer,
      deployment: config.deployment,
      measurementId: config.measurementId,
    }),
    sessions: createSessionStore({ now: nowSecs }),
    fiuKey,
    policy: config.policy,
    measurementId: config.measurementId,
    now: nowSecs,
    rateLimiter: createRateLimiter({ now: () => Date.now() }),
    config: {
      allowedOrigin: config.allowedOrigin,
      trustProxy: config.trustProxy,
      info: {
        cluster: config.cluster,
        oracle_program: config.deployment.oracleProgram,
        credential: config.deployment.credential,
        schema: config.deployment.schema,
        measurement_id: config.measurementId,
        policy_hash: config.policyHash,
        attester_address: info.attester_address,
      },
    },
  });
  const server = serve({ fetch: app.fetch, port: config.port }, (s) => {
    process.stdout.write(
      `gateway listening on :${s.port} (${config.cluster}, measurement ${config.measurementId})\n`,
    );
  });
  // PID 1 in the container: stop on `docker stop` instead of waiting for SIGKILL.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) {
    process.stderr.write(`gateway: ${e.message}\n`);
  } else if (e instanceof GatewayError) {
    process.stderr.write(`gateway: boot failed (stage ${e.stage}, ${e.code})\n`);
  } else {
    process.stderr.write(`gateway: boot failed (${e instanceof Error ? e.name : 'unknown'})\n`);
  }
  process.exit(1);
});
