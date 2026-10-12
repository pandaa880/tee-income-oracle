// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RELEASE } from './release.ts';

describe('RELEASE', () => {
  it('is a v-prefixed semver', () => {
    expect(RELEASE).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('is the version release-please recorded for the repo', () => {
    const manifest = fileURLToPath(
      new URL('../../../.release-please-manifest.json', import.meta.url),
    );
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const version =
      typeof parsed === 'object' && parsed !== null && '.' in parsed ? parsed['.'] : undefined;
    expect(RELEASE).toBe(`v${String(version)}`);
  });
});
