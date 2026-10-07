/**
 * Local run: `pnpm --filter @tio/sandbox-bank start:local`. Loads the demo
 * keys from `sandbox-bank/.secrets/` (made once by `gen:demo-keys`, never
 * committed) unless the variables are already set, defaults the RPC to a
 * local validator, then starts the service.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SECRETS = fileURLToPath(new URL('../../.secrets/', import.meta.url));

function demoKey(name: string): string {
  try {
    return readFileSync(`${SECRETS}${name}.demo-private.jwk.json`, 'utf8');
  } catch {
    console.error(
      `sandbox-bank: no ${name} demo key in ${SECRETS}; run \`pnpm --filter @tio/sandbox-bank gen:demo-keys\` once`,
    );
    return process.exit(1);
  }
}

process.env['SANDBOX_AA_PRIVATE_JWK'] ??= demoKey('aa');
process.env['SANDBOX_FIP_PRIVATE_JWK'] ??= demoKey('fip');
process.env['SOLANA_RPC_URL'] ??= 'http://127.0.0.1:8899';

await import('./main.ts');
