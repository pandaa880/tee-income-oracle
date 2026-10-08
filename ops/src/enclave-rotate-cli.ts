// Usage: pnpm --filter @tio/ops enclave:rotate -- --cluster devnet --enclave-ip <ip>
// Needs `oyster-cvm` on PATH and the deployed enclave reachable on :1301 (attestation) and
// :8080 (/v1/info). Archives the attestation in deployments/<cluster>/. Env: see ops/README.md.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { z } from 'zod';
import { chainClients, cliOptions, deploymentPath, readKeypair, repoPath, runCli } from './cli.ts';
import { parseCluster } from './cluster.ts';
import { loadConfig } from './config.ts';
import { type RotatePorts, runRotate } from './rotate.ts';

const run = promisify(execFile);
const COMPOSE = repoPath('enclave/docker-compose.yml');
const ATTESTATION_PORT = 1301; // Oyster attests the secp256k1 key (/app/ecdsa.pub) here
const ENCLAVE_PORT = 8080;
const HTTP_TIMEOUT_MS = 15_000;
const InfoSchema = z.object({ attester_address: z.string() });

/** stdout + stderr of `oyster-cvm`; a non-zero exit rejects (the parsers then never run). */
async function oysterCvm(args: string[]): Promise<string> {
  // The parsers read INFO lines: pin the log level and drop colour whatever the shell sets.
  const env = { ...process.env, RUST_LOG: 'info', NO_COLOR: '1' };
  const { stdout, stderr } = await run('oyster-cvm', args, { timeout: 120_000, env });
  return `${stdout}\n${stderr}`;
}

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response;
}

function oysterPorts(ip: string): RotatePorts {
  return {
    composeText: () => readFile(COMPOSE, 'utf8'),
    computeImageId: () =>
      oysterCvm(['compute-image-id', '--docker-compose', COMPOSE, '--arch', 'arm64']),
    fetchAttestationHex: async () =>
      (await get(`http://${ip}:${ATTESTATION_PORT}/attestation/hex`)).text(),
    verify: (hexFile, imageIdHex) =>
      oysterCvm([
        'verify',
        '--attestation-hex-file',
        hexFile,
        '--image-id',
        imageIdHex,
        '--arch',
        'arm64',
      ]),
    enclaveInfo: async () =>
      InfoSchema.parse(await (await get(`http://${ip}:${ENCLAVE_PORT}/v1/info`)).json()),
  };
}

async function main(): Promise<void> {
  const options = cliOptions(['cluster', 'enclave-ip']);
  const cluster = parseCluster(options.cluster);
  const ip = options['enclave-ip'] ?? '';
  if (isIP(ip) !== 4) throw new Error('--enclave-ip must be an IPv4 address');
  const config = loadConfig(process.env);
  const result = await runRotate({
    ...chainClients(config),
    cluster,
    admin: await readKeypair(config.adminKeypairPath),
    deploymentPath: deploymentPath(cluster),
    archiveDir: repoPath(`deployments/${cluster}`),
    ports: oysterPorts(ip),
  });
  const { measurementId } = result;
  process.stdout.write(
    [
      `${result.registered ? 'registered' : 'already registered:'} measurement_id ${measurementId}`,
      `revoked: ${result.revoked.join(', ') || 'none'}; pools updated: ${result.poolsUpdated.length}`,
      `attestation archived: ${result.attestationFile}`,
      ...result.warnings.map((w) => `WARNING: ${w}`),
      'point the gateway at it:',
      `  az containerapp update -g tio-demo -n gateway --set-env-vars MEASUREMENT_ID=${measurementId}`,
      '',
    ].join('\n'),
  );
}

runCli(main);
