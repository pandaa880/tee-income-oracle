import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { signDetached, verifyDetached } from '../crypto/jws.ts';
import { generateDemoKeyFiles } from '../demo/demo-keys.ts';
import { KEYS_DIR } from '../vectors/paths.ts';
import { pinned } from '../vectors/keys.ts';
import { ConfigError, loadConfig } from './config.ts';

const demo = generateDemoKeyFiles();
const AA_PRIVATE = demo.secrets.get('aa.demo-private.jwk.json') ?? '';
const FIP_PRIVATE = demo.secrets.get('fip.demo-private.jwk.json') ?? '';

function pinnedDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tio-pinned-'));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const goodPins = {
  'aa.jwk.json': demo.pinned.get('aa.jwk.json') ?? '',
  'fip.jwk.json': demo.pinned.get('fip.jwk.json') ?? '',
};

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SANDBOX_AA_PRIVATE_JWK: AA_PRIVATE,
    SANDBOX_FIP_PRIVATE_JWK: FIP_PRIVATE,
    SOLANA_RPC_URL: 'http://127.0.0.1:8899',
    PINNED_DIR: pinnedDir(goodPins),
    BANK_ALLOW_NO_TOKEN: '1',
    ...over,
  };
}

function pinKid(text: string): unknown {
  return (JSON.parse(text) as { kid: unknown }).kid;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('loadConfig: accepted', () => {
  it('loads demo keys whose public halves equal the pinned files', () => {
    const config = loadConfig(env());
    expect(config.aa.kid).toBe(pinKid(goodPins['aa.jwk.json']));
    expect(config.fip.kid).toBe(pinKid(goodPins['fip.jwk.json']));
  });

  it('returns keys that sign what the pinned key verifies', () => {
    const config = loadConfig(env());
    const body = new TextEncoder().encode('{"x":1}');
    const jws = signDetached(body, config.aa);
    expect(verifyDetached(jws, body, [pinned(config.aa)]).ok).toBe(true);
  });

  it('defaults: port 8081 and the deployed oracle program id', () => {
    const config = loadConfig(env());
    expect(config.port).toBe(8081);
    expect(config.programId).toBe('HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8');
  });

  it('reads PORT, ORACLE_PROGRAM_ID and SOLANA_RPC_URL', () => {
    const config = loadConfig(
      env({ PORT: '9123', ORACLE_PROGRAM_ID: 'Pr0gram1111111111111111111111111111111111' }),
    );
    expect(config.port).toBe(9123);
    expect(config.programId).toBe('Pr0gram1111111111111111111111111111111111');
    expect(config.rpcUrl).toBe('http://127.0.0.1:8899');
  });
});

describe('loadConfig: refused', () => {
  it.each(['SANDBOX_AA_PRIVATE_JWK', 'SANDBOX_FIP_PRIVATE_JWK', 'SOLANA_RPC_URL'])(
    'refuses to start without %s',
    (name) => {
      expect(thrown(() => loadConfig(env({ [name]: undefined })))).toBeInstanceOf(ConfigError);
    },
  );

  it('refuses an empty key variable', () => {
    expect(thrown(() => loadConfig(env({ SANDBOX_AA_PRIVATE_JWK: '' })))).toBeInstanceOf(
      ConfigError,
    );
  });

  it('refuses a key that is flagged private_key_test_only, even when its public half is pinned', () => {
    const testAa = readFileSync(join(KEYS_DIR, 'aa.test-private.jwk.json'), 'utf8');
    const testAaPublic = readFileSync(join(KEYS_DIR, 'aa.public.jwk.json'), 'utf8');
    const dir = pinnedDir({
      'aa.jwk.json': testAaPublic,
      'fip.jwk.json': goodPins['fip.jwk.json'],
    });
    const error = thrown(() =>
      loadConfig(env({ SANDBOX_AA_PRIVATE_JWK: testAa, PINNED_DIR: dir })),
    );
    expect(error).toBeInstanceOf(ConfigError);
  });

  it('refuses a key whose public half differs from the pinned file (other key)', () => {
    const other = generateDemoKeyFiles();
    const dir = pinnedDir({
      'aa.jwk.json': other.pinned.get('aa.jwk.json') ?? '',
      'fip.jwk.json': goodPins['fip.jwk.json'],
    });
    expect(thrown(() => loadConfig(env({ PINNED_DIR: dir })))).toBeInstanceOf(ConfigError);
  });

  it('refuses a key whose modulus matches but whose kid differs from the pinned file', () => {
    const pin = {
      ...(JSON.parse(goodPins['fip.jwk.json']) as Record<string, unknown>),
      kid: randomUUID(),
    };
    const dir = pinnedDir({
      'aa.jwk.json': goodPins['aa.jwk.json'],
      'fip.jwk.json': JSON.stringify(pin),
    });
    expect(thrown(() => loadConfig(env({ PINNED_DIR: dir })))).toBeInstanceOf(ConfigError);
  });

  it('refuses AA and FIP keys swapped between the variables', () => {
    const error = thrown(() =>
      loadConfig(env({ SANDBOX_AA_PRIVATE_JWK: FIP_PRIVATE, SANDBOX_FIP_PRIVATE_JWK: AA_PRIVATE })),
    );
    expect(error).toBeInstanceOf(ConfigError);
  });

  it('refuses a missing pinned file', () => {
    const dir = pinnedDir({ 'aa.jwk.json': goodPins['aa.jwk.json'] });
    expect(thrown(() => loadConfig(env({ PINNED_DIR: dir })))).toBeInstanceOf(ConfigError);
  });

  it('refuses an RSA key shorter than 2048 bits', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const jwk = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID() };
    const publicJwk = { kty: 'RSA', n: jwk.n, e: jwk.e, kid: jwk.kid };
    const dir = pinnedDir({
      'aa.jwk.json': JSON.stringify(publicJwk),
      'fip.jwk.json': goodPins['fip.jwk.json'],
    });
    const error = thrown(() =>
      loadConfig(env({ SANDBOX_AA_PRIVATE_JWK: JSON.stringify(jwk), PINNED_DIR: dir })),
    );
    expect(error).toBeInstanceOf(ConfigError);
  });

  it('refuses a key variable that is not JSON', () => {
    expect(thrown(() => loadConfig(env({ SANDBOX_AA_PRIVATE_JWK: 'not json' })))).toBeInstanceOf(
      ConfigError,
    );
  });

  it('refuses a public-only JWK where a private key is required', () => {
    const error = thrown(() =>
      loadConfig(env({ SANDBOX_AA_PRIVATE_JWK: goodPins['aa.jwk.json'] })),
    );
    expect(error).toBeInstanceOf(ConfigError);
  });

  it.each(['abc', '0', '70000', '-1', '80.5'])('refuses PORT=%s', (port) => {
    expect(thrown(() => loadConfig(env({ PORT: port })))).toBeInstanceOf(ConfigError);
  });

  it('never puts private key material in the error message', () => {
    const jwk = JSON.parse(AA_PRIVATE) as { d: string; p: string };
    const dir = pinnedDir({ 'aa.jwk.json': '{}', 'fip.jwk.json': goodPins['fip.jwk.json'] });
    const error = thrown(() => loadConfig(env({ PINNED_DIR: dir })));
    expect(error).toBeInstanceOf(ConfigError);
    const text = (error as Error).message;
    expect(text).not.toContain(jwk.d);
    expect(text).not.toContain(jwk.p);
  });
});

describe('loadConfig: BANK_TOKEN (bearer token for the gateway)', () => {
  const TOKEN = 'bank-token-0123456789-abcdefghijklmnop'; // 38 chars

  it('with the explicit opt-out, an absent token means token is undefined', () => {
    expect(loadConfig(env({ BANK_ALLOW_NO_TOKEN: '1' })).token).toBeUndefined();
  });

  it('is required: no token and no opt-out is a ConfigError naming BANK_TOKEN', () => {
    const error = thrown(() => loadConfig(env({ BANK_ALLOW_NO_TOKEN: undefined })));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('BANK_TOKEN');
  });

  it.each(['true', '0', '', 'yes', ' 1'])(
    'the opt-out must be exactly "1": BANK_ALLOW_NO_TOKEN=%j is still a ConfigError',
    (value) => {
      const error = thrown(() => loadConfig(env({ BANK_ALLOW_NO_TOKEN: value })));
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('BANK_TOKEN');
    },
  );

  it('a token plus the opt-out keeps the token', () => {
    expect(loadConfig(env({ BANK_TOKEN: TOKEN, BANK_ALLOW_NO_TOKEN: '1' })).token).toBe(TOKEN);
  });

  it('accepts a token of exactly 32 characters', () => {
    const t = 'k'.repeat(32);
    expect(loadConfig(env({ BANK_TOKEN: t })).token).toBe(t);
  });

  it('accepts a longer token', () => {
    expect(loadConfig(env({ BANK_TOKEN: TOKEN })).token).toBe(TOKEN);
  });

  it('refuses a 31-character token, names BANK_TOKEN, never prints the value', () => {
    const short = 'secret-token-value-xyz-0123456a'.slice(0, 31);
    expect(short).toHaveLength(31);
    const error = thrown(() => loadConfig(env({ BANK_TOKEN: short })));
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain('BANK_TOKEN');
    expect(message).not.toContain(short);
  });

  it.each([
    ['nothing (empty)', ''],
    ['a trailing newline', `${TOKEN}\n`],
    ['inner whitespace', `${TOKEN.slice(0, 20)} ${TOKEN.slice(20)}`],
    ['a non-ASCII character', `${TOKEN}é`],
  ])('refuses a token with %s (not RFC 6750 token68)', (_, bad) => {
    const error = thrown(() => loadConfig(env({ BANK_TOKEN: bad })));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('BANK_TOKEN');
    if (bad !== '') expect((error as Error).message).not.toContain(bad);
  });

  it('accepts base64-style padding at the end of the token', () => {
    const t = `${'a'.repeat(30)}==`;
    expect(loadConfig(env({ BANK_TOKEN: t })).token).toBe(t);
  });

  it.each([
    ['an inner "="', `${'a'.repeat(16)}=${'a'.repeat(16)}`],
    ['only padding characters', '='.repeat(32)],
  ])('refuses a token with %s (not a b64token)', (_, bad) => {
    const error = thrown(() => loadConfig(env({ BANK_TOKEN: bad })));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('BANK_TOKEN');
    expect((error as Error).message).not.toContain(bad);
  });
});
