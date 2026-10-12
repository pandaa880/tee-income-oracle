// @vitest-environment node
// Import rules of CODING-GUIDELINES §3 as a test: dependencies point inward.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const SELF = 'architecture.test.ts';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);
const files = walk(SRC).map((path) => ({
  rel: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));
const inFolder = (folder: string) =>
  files.filter((f) => f.rel.startsWith(`${folder}/`) && !isTest(f.rel));

/** Module specifiers of every import / export-from / dynamic import in the source text. */
function specifiers(text: string): string[] {
  const found = text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g);
  return [...found].map((match) => match[1] ?? '');
}

function offenders(folder: string, forbidden: RegExp): string[] {
  return inFolder(folder).flatMap((f) =>
    specifiers(f.text)
      .filter((s) => forbidden.test(s))
      .map((s) => `${f.rel} imports ${s}`),
  );
}

describe('architecture', () => {
  it('finds the layers it checks (guards against a vacuous pass)', () => {
    expect(inFolder('domain').length).toBeGreaterThan(5);
    expect(inFolder('adapters').length).toBeGreaterThan(3);
    expect(inFolder('app').length).toBeGreaterThan(3);
    expect(inFolder('pages').length).toBeGreaterThan(0);
  });

  it('domain/ imports no react, TanStack, adapters or app', () => {
    expect(
      offenders('domain', /^react(-dom)?(\/|$)|^@tanstack\/|(^|\/)adapters(\/|$)|(^|\/)app(\/|$)/),
    ).toEqual([]);
  });

  it('domain/ touches no DOM, storage or fetch', () => {
    const globals =
      /\b(sessionStorage|localStorage|document|window|navigator)\.|\bfetch\s*\(|\bXMLHttpRequest\b/;
    const bad = inFolder('domain')
      .filter((f) => globals.test(f.text))
      .map((f) => f.rel);
    expect(bad).toEqual([]);
  });

  it('pages/ import no adapters', () => {
    expect(offenders('pages', /(^|\/)adapters(\/|$)/)).toEqual([]);
  });

  it('nothing in src reads process.* (browser code uses import.meta.env)', () => {
    const reads = new RegExp(['\\bproc', 'ess\\.'].join(''));
    const bad = files.filter((f) => f.rel !== SELF && reads.test(f.text)).map((f) => f.rel);
    expect(bad).toEqual([]);
  });
});
