// The library part of @tio/verifier must run in a browser: no `node:` import and no `process.`
// outside src/cli.ts and src/node/.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function libraryFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map((path) => path.split('\\').join('/'))
    .filter((path) => path.endsWith('.ts'))
    .filter((path) => !path.endsWith('.test.ts'))
    .filter((path) => path !== 'test-fixtures.ts' && path !== 'cli.ts')
    .filter((path) => !path.startsWith('node/'));
}

describe('library sources', () => {
  it('include_the_expected_modules', () => {
    const files = libraryFiles();
    for (const expected of [
      'verify.ts',
      'report.ts',
      'sources.ts',
      'deployment.ts',
      'errors.ts',
      'eth-address.ts',
      'nitro/cose.ts',
      'nitro/document.ts',
      'nitro/x509.ts',
      'chain/kit.ts',
      'chain/registry.ts',
    ]) {
      expect(files).toContain(expected);
    }
  });

  it('do_not_import_node_modules', () => {
    const offenders = libraryFiles().filter((file) =>
      /from\s+['"]node:/.test(readFileSync(`${SRC}${file}`, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('do_not_use_process', () => {
    const offenders = libraryFiles().filter((file) =>
      /\bprocess\./.test(readFileSync(`${SRC}${file}`, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
