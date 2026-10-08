/**
 * CLI: create the sandbox bank's DEMO keys once. Refuses to overwrite: the
 * public halves are compiled into the enclave image, so new keys mean a new
 * image id and a new registration.
 * Usage: pnpm --filter @tio/sandbox-bank gen:demo-keys
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDemoKeyFiles } from './demo-keys.ts';

const SECRETS_DIR = fileURLToPath(new URL('../../.secrets/', import.meta.url));
const PINNED_DIR = fileURLToPath(new URL('../../../enclave/pinned/', import.meta.url));

const { secrets, pinned } = generateDemoKeyFiles();
const targets = [
  ...[...secrets.keys()].map((name) => join(SECRETS_DIR, name)),
  ...[...pinned.keys()].map((name) => join(PINNED_DIR, name)),
];
const existing = targets.filter((path) => existsSync(path));
if (existing.length > 0) {
  console.error(`refusing to overwrite existing demo keys: ${existing.join(', ')}`);
  process.exit(1);
}
mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
mkdirSync(PINNED_DIR, { recursive: true });
for (const [name, text] of secrets) {
  writeFileSync(join(SECRETS_DIR, name), text, { mode: 0o600 });
}
for (const [name, text] of pinned) {
  writeFileSync(join(PINNED_DIR, name), text);
}
console.error(
  `wrote ${secrets.size} demo private keys to ${SECRETS_DIR} (back them up outside the repo)`,
);
console.error(`wrote ${pinned.size} pinned public keys to ${PINNED_DIR}`);
