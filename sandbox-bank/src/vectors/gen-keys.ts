/**
 * CLI: create the TEST-ONLY keys once. Refuses to overwrite existing keys,
 * because every committed vector depends on them.
 * Usage: pnpm --filter @tio/sandbox-bank gen:keys
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateKeyFiles } from './keys.ts';
import { KEYS_DIR } from './paths.ts';

const files = generateKeyFiles();
const existing = [...files.keys()].filter((name) => existsSync(join(KEYS_DIR, name)));
if (existing.length > 0) {
  console.error(`refusing to overwrite existing test keys: ${existing.join(', ')}`);
  process.exit(1);
}
mkdirSync(KEYS_DIR, { recursive: true });
for (const [name, text] of files) {
  writeFileSync(join(KEYS_DIR, name), text);
}
console.error(`wrote ${files.size} TEST-ONLY key files to ${KEYS_DIR}`);
