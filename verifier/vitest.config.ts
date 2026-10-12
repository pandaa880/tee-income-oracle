import { configDefaults, defineConfig } from 'vitest/config';

// Default run (`pnpm test`, CI `ts` job): no `anchor build` needed. The suite that loads
// target/deploy/*.so is `*.programs.test.ts` and runs via `pnpm test:programs`.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: [...configDefaults.exclude, '**/*.programs.test.ts'],
  },
});
