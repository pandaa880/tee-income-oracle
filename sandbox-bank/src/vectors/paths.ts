/** Filesystem locations of test-vectors/, resolved from this file. */

import { fileURLToPath } from 'node:url';

/** Repo-root `test-vectors/` directory. */
export const TEST_VECTORS_DIR = fileURLToPath(new URL('../../../test-vectors/', import.meta.url));

/** `test-vectors/keys/`. */
export const KEYS_DIR = fileURLToPath(new URL('../../../test-vectors/keys/', import.meta.url));
