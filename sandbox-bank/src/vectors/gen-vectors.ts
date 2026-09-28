/**
 * CLI: regenerate test-vectors/ from the committed test keys.
 * Usage: pnpm --filter @tio/sandbox-bank gen:vectors
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { GENERATED_PATHS, generateAll } from './generate.ts';
import { loadTestKeys } from './keys.ts';
import { KEYS_DIR, TEST_VECTORS_DIR } from './paths.ts';

const files = generateAll(loadTestKeys(KEYS_DIR));
// Wipe first so a removed case can't linger as a stale directory.
for (const p of GENERATED_PATHS) {
  rmSync(join(TEST_VECTORS_DIR, p), { recursive: true, force: true });
}
for (const [path, bytes] of files) {
  const target = join(TEST_VECTORS_DIR, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
console.error(`wrote ${files.size} files to ${TEST_VECTORS_DIR}`);
