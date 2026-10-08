import { configDefaults, defineConfig } from 'vitest/config';

// Default run (`pnpm test`, CI `ts` job): no `anchor build` needed. The suites that load
// target/deploy/*.so are `*.programs.test.ts` and run via `pnpm test:programs`.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    exclude: [...configDefaults.exclude, '**/*.programs.test.ts'],
  },
});
