import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = import.meta.dirname;
const PACKAGE_JSON = join(SRC, '..', 'package.json');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function rel(path: string): string {
  return relative(SRC, path).split(sep).join('/');
}

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

function isSourceFile(path: string): boolean {
  return /\.tsx?$/.test(path);
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function componentFolders(group: 'primitives' | 'patterns'): string[] {
  const dir = join(SRC, group);
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
}

function exportTargets(): string[] {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { exports: Record<string, string> };
  return Object.values(pkg.exports);
}

const sourceFiles = walk(SRC).filter(isSourceFile);

describe('repo rules', () => {
  it('has no colour literal (#hex, rgb(, hsl(, oklch() in src outside tokens/ (test files and comments excluded)', () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/;
    const offenders = sourceFiles
      .filter((f) => !rel(f).startsWith('tokens/') && !isTestFile(f))
      .filter((f) => literal.test(stripComments(readFileSync(f, 'utf8'))))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it.each(['primitives', 'patterns'] as const)(
    'has a package.json exports entry for every %s folder',
    (group) => {
      const targets = exportTargets();
      const missing = componentFolders(group).filter(
        (name) => !targets.includes(`./src/${group}/${name}/${name}.tsx`),
      );
      expect(missing).toEqual([]);
    },
  );

  it('has no barrel file (index.ts / index.tsx) anywhere in src', () => {
    const barrels = walk(SRC)
      .filter((f) => /(^|[\\/])index\.tsx?$/.test(f))
      .map(rel);
    expect(barrels).toEqual([]);
  });

  it('imports nothing from @solana, web/ or other @tio packages', () => {
    const specifier = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
    const offenders = sourceFiles.flatMap((file) =>
      Array.from(stripComments(readFileSync(file, 'utf8')).matchAll(specifier))
        .map((m) => m[1] ?? '')
        .filter(
          (spec) =>
            spec.startsWith('@solana') ||
            /(^|\/)web(\/|$)/.test(spec) ||
            (spec.startsWith('@tio/') && spec !== '@tio/ui' && !spec.startsWith('@tio/ui/')),
        )
        .map((spec) => `${rel(file)} -> ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});
