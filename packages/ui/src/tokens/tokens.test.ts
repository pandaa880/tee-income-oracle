import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TONES } from './tokens.ts';

const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

type Vars = Map<string, string>;

/** Body of the first top-level rule whose selector matches exactly. */
function ruleBody(selector: string): string {
  const start = cssNoComments.search(new RegExp(`^${selector}\\s*\\{`, 'm'));
  if (start < 0) throw new Error(`rule not found: ${selector}`);
  const open = cssNoComments.indexOf('{', start);
  const close = cssNoComments.indexOf('}', open);
  return cssNoComments.slice(open + 1, close);
}

function parseVars(body: string): Vars {
  const vars: Vars = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(m[1] ?? '', (m[2] ?? '').trim());
  }
  return vars;
}

function resolve(name: string, vars: Vars, light: Vars, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`cycle at ${name}`);
  seen.add(name);
  const value = vars.get(name) ?? light.get(name);
  if (value === undefined) throw new Error(`undefined token ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? resolve(ref[1] ?? '', vars, light, seen) : value;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1] ?? '', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = parseVars(ruleBody(':root'));
const dark = parseVars(ruleBody(":root\\[data-theme='dark'\\]"));
const themes = { light: light, dark: new Map([...light, ...dark]) };

const TEXT_PAIRS: [string, string][] = [
  ['--foreground', '--background'],
  ['--muted-foreground', '--background'],
  ['--foreground', '--card'],
  ['--primary-foreground', '--primary'],
];
const TONE_PAIRS: [string, string][] = TONES.map((t) => [`--tone-${t}`, '--card']);

describe.each(Object.entries(themes))('contrast (%s)', (_name, vars) => {
  // Plan allows 3:1 for display sizes; the tokens are documented >= 5.2:1, so hold all to 4.5.
  it.each([...TEXT_PAIRS, ...TONE_PAIRS])('%s on %s is at least 4.5:1', (fg, bg) => {
    const ratio = contrast(resolve(fg, vars, light), resolve(bg, vars, light));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

describe('tone aliases', () => {
  const expected: Record<string, string> = {
    positive: '--status-fresh',
    info: '--tier-b',
    caution: '--status-stale',
    negative: '--status-revoked',
    accent: '--status-old-policy',
    neutral: '--muted-foreground',
  };

  it.each(Object.entries(expected))('--tone-%s aliases %s in the light theme', (tone, target) => {
    expect(light.get(`--tone-${tone}`)).toBe(`var(${target})`);
  });
});

describe('reduced motion', () => {
  const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\})\s*\}/.exec(
    cssNoComments,
  );

  it('has a prefers-reduced-motion: reduce block', () => {
    expect(block).not.toBeNull();
  });

  it.each(['--dur-fast', '--dur-line', '--stagger', '--dur-stamp'])('zeroes %s', (name) => {
    expect(block?.[1]).toMatch(new RegExp(`${name}:\\s*0ms`));
  });
});

describe('dark palette', () => {
  // The dark values are written twice (system preference and explicit toggle); keep them equal.
  it('the prefers-color-scheme block matches the [data-theme=dark] block', () => {
    const system = parseVars(ruleBody("\\s*:root:not\\(\\[data-theme='light'\\]\\)"));
    expect(Object.fromEntries(system)).toEqual(Object.fromEntries(dark));
  });
});
