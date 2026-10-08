import { homedir } from 'node:os';
import { type Address, isAddress } from '@solana/kit';
import { z } from 'zod';

export type Config = {
  rpcUrl: string;
  wsUrl: string;
  adminKeypairPath: string;
  oracleProgramId: Address;
};

const DEFAULT_ADMIN_KEYPAIR = '~/.config/solana/tee-income-oracle.json';

function urlWithScheme(schemes: readonly string[]) {
  return z.url().refine((value) => schemes.some((s) => value.startsWith(`${s}://`)), {
    message: `must start with ${schemes.map((s) => `${s}://`).join(' or ')}`,
  });
}

const EnvSchema = z.object({
  SOLANA_RPC_URL: urlWithScheme(['http', 'https']),
  SOLANA_WS_URL: urlWithScheme(['ws', 'wss']),
  ADMIN_KEYPAIR: z.string().min(1).default(DEFAULT_ADMIN_KEYPAIR),
  ORACLE_PROGRAM_ID: z.string().refine(isAddress, { message: 'must be a base58 32-byte address' }),
});

/**
 * Read the ops config from environment variables.
 *
 * @throws Error naming every invalid or missing key.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid environment: ${problems.join('; ')}`);
  }
  const { SOLANA_RPC_URL, SOLANA_WS_URL, ADMIN_KEYPAIR, ORACLE_PROGRAM_ID } = parsed.data;
  return {
    rpcUrl: SOLANA_RPC_URL,
    wsUrl: SOLANA_WS_URL,
    adminKeypairPath: expandHome(ADMIN_KEYPAIR),
    oracleProgramId: ORACLE_PROGRAM_ID,
  };
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path;
}
