import { defineConfig } from 'vitest/config';

// `pnpm test:programs` (CI `programs` job, after `anchor build`): surfnet suites that deploy the
// oracle and demo-pool binaries. Each boots its own surfnet, so files run one at a time.
export default defineConfig({
  test: {
    include: ['src/**/*.programs.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
