import { defineConfig } from 'vitest/config';

// `pnpm test:programs` (CI `programs` job, after `anchor build`): the surfnet suite that deploys
// the oracle and SAS binaries and runs the CLI against them.
export default defineConfig({
  test: {
    include: ['src/**/*.programs.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
