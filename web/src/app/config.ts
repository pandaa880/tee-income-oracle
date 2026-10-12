// Build-time configuration, parsed once at the edge. Every VITE_* value is public (it ships
// in the bundle), so nothing secret belongs here: the RPC is the public devnet endpoint.
import { type Address, address } from '@solana/kit';
import { z } from 'zod';
import devnet from '../../../deployments/devnet.json';

export type Features = { verify: boolean; book: boolean };

export type Deployment = {
  cluster: string;
  oracleProgram: Address;
  sasSigner: Address;
  authority: Address;
  credential: Address;
  schema: Address;
  mint: Address;
  pools: { address: Address; poolId: number }[];
};

export type Config = {
  gatewayUrl: string;
  rpcUrl: string;
  cluster: 'devnet';
  deployment: Deployment;
  features: Features;
};

/** Gates nav items and CTAs per PR: verify (5b) and the loan book (5c) are off until they ship. */
const FEATURES: Features = { verify: false, book: false };

const isLocal = (host: string) => host === 'localhost' || host === '127.0.0.1';

/** https anywhere, http only on localhost, or a same-origin path (the dev proxy, e.g. `/gw`). */
function serviceUrl(name: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  // `//host` is protocol-relative (cross-origin), not a same-origin path.
  if (/^\/[^/]/.test(value)) return value.replace(/\/$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && isLocal(url.hostname));
  if (!allowed) throw new Error(`${name} must use https (http only for localhost)`);
  return value.replace(/\/$/, '');
}

const deploymentSchema = z.object({
  cluster: z.string(),
  oracle_program: z.string(),
  sas_signer: z.string(),
  authority: z.string(),
  credential: z.string(),
  schema: z.string(),
  mint: z.string(),
  pools: z.array(z.object({ address: z.string(), pool_id: z.number().int() })),
});

function loadDeployment(raw: unknown): Deployment {
  const d = deploymentSchema.parse(raw);
  return {
    cluster: d.cluster,
    oracleProgram: address(d.oracle_program),
    sasSigner: address(d.sas_signer),
    authority: address(d.authority),
    credential: address(d.credential),
    schema: address(d.schema),
    mint: address(d.mint),
    pools: d.pools.map((p) => ({ address: address(p.address), poolId: p.pool_id })),
  };
}

/** Throws a message naming the bad variable; `main.tsx` shows it instead of a blank page. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const gatewayUrl = serviceUrl('VITE_GATEWAY_URL', env['VITE_GATEWAY_URL']);
  const rpcUrl = serviceUrl('VITE_RPC_URL', env['VITE_RPC_URL']);
  const cluster = env['VITE_CLUSTER'];
  if (cluster !== 'devnet')
    throw new Error(`VITE_CLUSTER must be "devnet", got ${String(cluster)}`);
  const deployment = loadDeployment(devnet);
  if (deployment.cluster !== cluster) {
    throw new Error(`bundled deployment is for ${deployment.cluster}, VITE_CLUSTER is ${cluster}`);
  }
  return { gatewayUrl, rpcUrl, cluster, deployment, features: FEATURES };
}
