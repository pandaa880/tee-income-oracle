// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GITHUB_URL, POLICY_URL, RELEASE } from './release.ts';

describe('POLICY_URL', () => {
  it('is the default policy JSON at the release tag on GitHub', () => {
    expect(POLICY_URL).toBe(`${GITHUB_URL}/blob/${RELEASE}/test-vectors/policy/default.json`);
  });
});

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
