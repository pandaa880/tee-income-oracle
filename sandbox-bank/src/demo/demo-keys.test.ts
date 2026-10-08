import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KEYS_DIR } from '../vectors/paths.ts';
import { DEMO_KEY_NAMES, generateDemoKeyFiles } from './demo-keys.ts';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parse(text: string | undefined): Record<string, unknown> {
  expect(text).toBeDefined();
  const value: unknown = JSON.parse(text ?? '');
  expect(typeof value).toBe('object');
  return value as Record<string, unknown>;
}

function testKid(name: string): string {
  const text = readFileSync(`${KEYS_DIR}${name}.public.jwk.json`, 'utf8');
  return String(parse(text).kid);
}

describe('generateDemoKeyFiles', () => {
  const files = generateDemoKeyFiles();

  it('names the secret files <name>.demo-private.jwk.json for aa and fip', () => {
    expect([...files.secrets.keys()].toSorted()).toEqual([
      'aa.demo-private.jwk.json',
      'fip.demo-private.jwk.json',
    ]);
  });

  it('names the pinned files <name>.jwk.json for aa and fip', () => {
    expect([...files.pinned.keys()].toSorted()).toEqual(['aa.jwk.json', 'fip.jwk.json']);
  });

  it('never flags a secret file private_key_test_only', () => {
    for (const text of files.secrets.values()) {
      expect(parse(text)).not.toHaveProperty('private_key_test_only');
    }
  });

  it('keeps the private exponent only in the secret files', () => {
    for (const text of files.secrets.values()) {
      expect(parse(text)).toHaveProperty('d');
    }
    for (const text of files.pinned.values()) {
      expect(parse(text)).not.toHaveProperty('d');
    }
  });

  it('pins public JWKs with exactly kty, n, e and kid', () => {
    for (const text of files.pinned.values()) {
      expect(Object.keys(parse(text)).toSorted()).toEqual(['e', 'kid', 'kty', 'n']);
      expect(parse(text).kty).toBe('RSA');
    }
  });

  it('gives each key a UUIDv4 kid', () => {
    for (const text of files.pinned.values()) {
      expect(String(parse(text).kid)).toMatch(UUID_V4);
    }
  });

  it('uses kids that differ from every test-vector kid and from each other', () => {
    const testKids = ['aa', 'fip', 'fiu', 'rogue'].map(testKid);
    const demoKids = [...files.pinned.values()].map((t) => String(parse(t).kid));
    expect(new Set(demoKids).size).toBe(DEMO_KEY_NAMES.length);
    for (const kid of demoKids) {
      expect(testKids).not.toContain(kid);
    }
  });

  it('publishes the same modulus, exponent and kid as the private half', () => {
    for (const name of DEMO_KEY_NAMES) {
      const priv = parse(files.secrets.get(`${name}.demo-private.jwk.json`));
      const pub = parse(files.pinned.get(`${name}.jwk.json`));
      expect(pub.n).toBe(priv.n);
      expect(pub.e).toBe(priv.e);
      expect(pub.kid).toBe(priv.kid);
    }
  });

  it('generates fresh moduli on each call', () => {
    const other = generateDemoKeyFiles();
    expect(parse(other.pinned.get('aa.jwk.json')).n).not.toBe(
      parse(files.pinned.get('aa.jwk.json')).n,
    );
  });
});
