import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GENERATOR_VERSION, generateAll } from './generate.ts';
import { loadTestKeys, type TestKeys } from './keys.ts';

interface ManifestCase {
  readonly id: string;
  readonly kind: 'positive' | 'negative';
  readonly dir: string;
  readonly persona_id: string;
  readonly expected: unknown;
}

interface Manifest {
  readonly generator_version: number;
  readonly cases: readonly ManifestCase[];
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function loadKeys(): TestKeys {
  const keysDir = fileURLToPath(new URL('../../../test-vectors/keys/', import.meta.url));
  return loadTestKeys(keysDir);
}

function manifestOf(files: ReadonlyMap<string, Uint8Array>): Manifest {
  const bytes = required(files.get('manifest.json'), 'generateAll must emit manifest.json');
  return JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
}

describe('generateAll', () => {
  it('is deterministic: two runs produce byte-identical output', () => {
    const keys = loadKeys();
    const first = generateAll(keys);
    const second = generateAll(keys);

    expect([...first.keys()].toSorted()).toEqual([...second.keys()].toSorted());
    for (const [path, bytes] of first) {
      expect(second.get(path)).toEqual(bytes);
    }
  });

  it('emits a manifest with generator_version 1', () => {
    const manifest = manifestOf(generateAll(loadKeys()));
    expect(manifest.generator_version).toBe(1);
    expect(manifest.generator_version).toBe(GENERATOR_VERSION);
  });

  it('lists exactly 6 positive and 9 negative cases', () => {
    const manifest = manifestOf(generateAll(loadKeys()));
    const positive = manifest.cases.filter((c) => c.kind === 'positive');
    const negative = manifest.cases.filter((c) => c.kind === 'negative');
    expect(positive).toHaveLength(6);
    expect(negative).toHaveLength(9);
  });

  it('lists every vectors/ and negative/ case directory exactly once', () => {
    const files = generateAll(loadKeys());
    const manifest = manifestOf(files);
    const dirs = manifest.cases.map((c) => c.dir);

    expect(new Set(dirs).size).toBe(dirs.length);

    for (const dir of dirs) {
      const hasFileUnderDir = [...files.keys()].some((path) => path.startsWith(`${dir}/`));
      expect(hasFileUnderDir).toBe(true);
    }
  });

  it('never emits a path outside test-vectors/ (no "..", no leading "/")', () => {
    const files = generateAll(loadKeys());
    for (const path of files.keys()) {
      expect(path.includes('..')).toBe(false);
      expect(path.startsWith('/')).toBe(false);
    }
  });
});
