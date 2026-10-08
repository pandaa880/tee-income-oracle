import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.ts';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const SECRET_BYTES = Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256);
const LOCALNET = JSON.parse(readFileSync(join(REPO_ROOT, 'deployments/localnet.json'), 'utf8')) as {
  oracle_program: string;
  credential: string;
  schema: string;
  sas_program: string;
};

type Env = Record<string, string | undefined>;

function env(over: Env = {}): Env {
  return {
    ENCLAVE_URL: 'http://enclave.internal:8080',
    BANK_URL: 'http://bank.internal:8081',
    SOLANA_RPC_URL: 'http://127.0.0.1:8899',
    CLUSTER: 'localnet',
    MEASUREMENT_ID: '0',
    RELAYER_KEYPAIR: JSON.stringify(SECRET_BYTES),
    ALLOWED_ORIGIN: 'http://localhost:3000',
    ...over,
  };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

/** The ConfigError for `over`, with its message, or a failed assertion. */
function configError(over: Env): ConfigError {
  const e = thrown(() => loadConfig(env(over), REPO_ROOT));
  expect(e).toBeInstanceOf(ConfigError);
  if (!(e instanceof ConfigError)) throw new Error('unreachable');
  return e;
}

describe('loadConfig: accepted', () => {
  it('maps the required variables', () => {
    const c = loadConfig(env(), REPO_ROOT);
    expect(c.enclaveUrl).toBe('http://enclave.internal:8080');
    expect(c.bankUrl).toBe('http://bank.internal:8081');
    expect(c.rpcUrl).toBe('http://127.0.0.1:8899');
    expect(c.cluster).toBe('localnet');
    expect(c.measurementId).toBe(0);
    expect(c.allowedOrigin).toBe('http://localhost:3000');
  });

  it('reads the deployment from deployments/<cluster>.json', () => {
    expect(loadConfig(env(), REPO_ROOT).deployment).toEqual({
      oracleProgram: LOCALNET.oracle_program,
      credential: LOCALNET.credential,
      schema: LOCALNET.schema,
      sasProgram: LOCALNET.sas_program,
    });
  });

  it('defaults: port 8082, trustProxy off', () => {
    const c = loadConfig(env(), REPO_ROOT);
    expect(c.port).toBe(8082);
    expect(c.trustProxy).toBe(false);
  });

  it('reads PORT', () => {
    expect(loadConfig(env({ PORT: '9000' }), REPO_ROOT).port).toBe(9000);
  });

  it("turns TRUST_PROXY '1' on and '0' off", () => {
    expect(loadConfig(env({ TRUST_PROXY: '1' }), REPO_ROOT).trustProxy).toBe(true);
    expect(loadConfig(env({ TRUST_PROXY: '0' }), REPO_ROOT).trustProxy).toBe(false);
  });

  it('accepts the measurement id range ends 0 and 254', () => {
    expect(loadConfig(env({ MEASUREMENT_ID: '254' }), REPO_ROOT).measurementId).toBe(254);
    expect(loadConfig(env({ MEASUREMENT_ID: '0' }), REPO_ROOT).measurementId).toBe(0);
  });

  it('returns the relayer secret as the 64 bytes given', () => {
    const c = loadConfig(env(), REPO_ROOT);
    expect(c.relayerSecret).toBeInstanceOf(Uint8Array);
    expect(Array.from(c.relayerSecret)).toEqual(SECRET_BYTES);
  });
});

describe('loadConfig: SOLANA_WS_URL', () => {
  it('uses the given value', () => {
    expect(loadConfig(env({ SOLANA_WS_URL: 'wss://ws.example/x' }), REPO_ROOT).wsUrl).toBe(
      'wss://ws.example/x',
    );
  });

  it('derives ws from http and moves port 8899 to 8900', () => {
    expect(loadConfig(env({ SOLANA_RPC_URL: 'http://127.0.0.1:8899' }), REPO_ROOT).wsUrl).toBe(
      'ws://127.0.0.1:8900',
    );
  });

  it('derives wss from https', () => {
    const c = loadConfig(env({ SOLANA_RPC_URL: 'https://api.devnet.solana.com' }), REPO_ROOT);
    expect(c.wsUrl.startsWith('wss://api.devnet.solana.com')).toBe(true);
  });

  it('keeps a non-default port as is', () => {
    expect(loadConfig(env({ SOLANA_RPC_URL: 'http://rpc.internal:9999' }), REPO_ROOT).wsUrl).toBe(
      'ws://rpc.internal:9999',
    );
  });
});

describe('loadConfig: policy', () => {
  it('defaults to test-vectors/policy/default.json parsed as JSON', () => {
    const file = readFileSync(join(REPO_ROOT, 'test-vectors/policy/default.json'), 'utf8');
    expect(loadConfig(env(), REPO_ROOT).policy).toEqual(JSON.parse(file));
  });

  it('hashes the default file to the committed default.hash', () => {
    const expected = readFileSync(
      join(REPO_ROOT, 'test-vectors/policy/default.hash'),
      'utf8',
    ).trim();
    expect(loadConfig(env(), REPO_ROOT).policyHash).toBe(expected);
  });

  it('hashes the exact file bytes of POLICY_PATH (relative to repoRoot or absolute)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tio-gw-policy-'));
    const path = join(dir, 'p.json');
    const bytes = Buffer.from('{"v":2,"x":[1,2]}');
    writeFileSync(path, bytes);
    const c = loadConfig(env({ POLICY_PATH: path }), REPO_ROOT);
    expect(c.policyHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(c.policy).toEqual({ v: 2, x: [1, 2] });
    const relative = loadConfig(
      env({ POLICY_PATH: 'test-vectors/policy/default.json' }),
      REPO_ROOT,
    );
    expect(relative.policyHash).toBe(loadConfig(env(), REPO_ROOT).policyHash);
  });
});

describe('loadConfig: rejected, naming the variable', () => {
  it.each([
    'ENCLAVE_URL',
    'BANK_URL',
    'SOLANA_RPC_URL',
    'CLUSTER',
    'MEASUREMENT_ID',
    'RELAYER_KEYPAIR',
    'ALLOWED_ORIGIN',
  ])('requires %s', (name) => {
    expect(configError({ [name]: undefined }).message).toContain(name);
  });

  it.each([['-1'], ['255'], ['1.5'], ['abc'], ['']])('rejects MEASUREMENT_ID %j', (value) => {
    expect(configError({ MEASUREMENT_ID: value }).message).toContain('MEASUREMENT_ID');
  });

  it.each([['not a url'], ['ftp://x'], ['']])('rejects ENCLAVE_URL %j', (value) => {
    expect(configError({ ENCLAVE_URL: value }).message).toContain('ENCLAVE_URL');
  });

  it('rejects a bad BANK_URL and SOLANA_RPC_URL', () => {
    expect(configError({ BANK_URL: 'nope' }).message).toContain('BANK_URL');
    expect(configError({ SOLANA_RPC_URL: 'nope' }).message).toContain('SOLANA_RPC_URL');
  });

  it.each([['abc'], ['0'], ['70000'], ['-5'], ['80.5']])('rejects PORT %j', (value) => {
    expect(configError({ PORT: value }).message).toContain('PORT');
  });

  it.each([['*'], ['https://app.example/'], ['https://app.example/path'], ['ftp://app.example']])(
    'rejects ALLOWED_ORIGIN %j (exact origin only)',
    (value) => {
      expect(configError({ ALLOWED_ORIGIN: value }).message).toContain('ALLOWED_ORIGIN');
    },
  );

  it.each([['http://127.0.0.1:8900'], ['not a url'], ['']])('rejects SOLANA_WS_URL %j', (value) => {
    expect(configError({ SOLANA_WS_URL: value }).message).toContain('SOLANA_WS_URL');
  });

  it('rejects an unknown CLUSTER (no deployments file)', () => {
    expect(configError({ CLUSTER: 'nonexistent-cluster' }).message).toContain('CLUSTER');
  });

  it('rejects a CLUSTER that escapes the deployments directory', () => {
    expect(configError({ CLUSTER: '../package' }).message).toContain('CLUSTER');
  });

  it('rejects a missing POLICY_PATH file', () => {
    expect(configError({ POLICY_PATH: 'test-vectors/policy/none.json' }).message).toContain(
      'POLICY_PATH',
    );
  });

  it.each([
    ['whitespace', '{ "v": 2 }'],
    ['a trailing newline', '{"v":2}\n'],
    ['unsorted keys', '{"x":1,"v":2}'],
    ['a float', '{"v":2.5}'],
  ])('rejects a POLICY_PATH file that is not exact JCS (%s)', (_name, text) => {
    const path = join(mkdtempSync(join(tmpdir(), 'tio-gw-policy-')), 'p.json');
    writeFileSync(path, text);
    expect(configError({ POLICY_PATH: path }).message).toContain('POLICY_PATH');
  });

  it('rejects a POLICY_PATH file that is not JSON', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tio-gw-policy-')), 'bad.json');
    writeFileSync(path, 'not json at all');
    expect(configError({ POLICY_PATH: path }).message).toContain('POLICY_PATH');
  });
});

describe('loadConfig: RELAYER_KEYPAIR is validated and never echoed', () => {
  const cases: [string, string][] = [
    ['not JSON', 'garbage-secret-xyz'],
    ['an object', JSON.stringify({ secret: 'garbage-secret-xyz' })],
    ['63 numbers', JSON.stringify(SECRET_BYTES.slice(0, 63))],
    ['65 numbers', JSON.stringify([...SECRET_BYTES, 1])],
    ['a number above 255', JSON.stringify([...SECRET_BYTES.slice(0, 63), 31337])],
    ['a negative number', JSON.stringify([...SECRET_BYTES.slice(0, 63), -2])],
    ['a non-integer', JSON.stringify([...SECRET_BYTES.slice(0, 63), 1.5])],
    ['a string element', JSON.stringify([...SECRET_BYTES.slice(0, 63), 'garbage-secret-xyz'])],
  ];

  it.each(cases)('rejects %s, names the variable, repeats nothing of the value', (_name, value) => {
    const e = configError({ RELAYER_KEYPAIR: value });
    expect(e.message).toContain('RELAYER_KEYPAIR');
    expect(e.message).not.toContain('garbage-secret-xyz');
    expect(e.message).not.toContain('31337');
    expect(e.message).not.toContain(value);
    expect(JSON.stringify(e.cause ?? null)).not.toContain('garbage-secret-xyz');
  });
});

describe('loadConfig: BANK_TOKEN', () => {
  it('is optional: absent means bankToken is undefined', () => {
    expect(loadConfig(env(), REPO_ROOT).bankToken).toBeUndefined();
  });

  it('maps a token of exactly 32 characters to bankToken', () => {
    const t = 'k'.repeat(32);
    expect(loadConfig(env({ BANK_TOKEN: t }), REPO_ROOT).bankToken).toBe(t);
  });

  it('rejects 31 characters, names BANK_TOKEN, repeats nothing of the value', () => {
    const short = 'garbage-token-xyz-0123456789abc'.slice(0, 31);
    expect(short).toHaveLength(31);
    const e = configError({ BANK_TOKEN: short });
    expect(e.message).toContain('BANK_TOKEN');
    expect(e.message).not.toContain(short);
    expect(JSON.stringify(e.cause ?? null)).not.toContain(short);
  });

  it.each([
    ['empty (a blank secret is a deploy mistake)', ''],
    ['a trailing newline', `${'k'.repeat(32)}\n`],
    ['inner whitespace', `${'k'.repeat(16)} ${'k'.repeat(16)}`],
    ['a non-ASCII character', `${'k'.repeat(32)}é`],
  ])('rejects a token that is %s', (_, bad) => {
    const message = configError({ BANK_TOKEN: bad }).message;
    expect(message).toContain('BANK_TOKEN');
    if (bad !== '') expect(message).not.toContain(bad);
  });

  it('accepts base64-style padding at the end of the token', () => {
    const t = `${'a'.repeat(30)}==`;
    expect(loadConfig(env({ BANK_TOKEN: t }), REPO_ROOT).bankToken).toBe(t);
  });

  it.each([
    ['an inner "="', `${'a'.repeat(16)}=${'a'.repeat(16)}`],
    ['only padding characters', '='.repeat(32)],
  ])('rejects a token with %s (not a b64token)', (_, bad) => {
    const message = configError({ BANK_TOKEN: bad }).message;
    expect(message).toContain('BANK_TOKEN');
    expect(message).not.toContain(bad);
  });
});

describe('loadConfig: BANK_URL transport when BANK_TOKEN is set', () => {
  const BANK_TOKEN = 'k'.repeat(32);

  it.each([
    'https://bank.example.com',
    'http://127.0.0.1:8081',
    'http://localhost:8081',
    'http://[::1]:8081',
    'http://10.0.0.5:8081',
    'http://192.168.1.2',
    'http://172.20.0.3',
    'http://bank',
    'http://bank.internal:8081',
  ])('accepts %s', (url) => {
    expect(loadConfig(env({ BANK_TOKEN, BANK_URL: url }), REPO_ROOT).bankToken).toBe(BANK_TOKEN);
  });

  it.each([
    'http://bank.example.com',
    'http://8.8.8.8:8081',
    'http://172.32.0.1',
    'http://[2001:db8::1]:8081',
    'http://[::ffff:8.8.8.8]',
    'http://10.0.0.5e0',
    'http://127.0.0.1.nip.io',
  ])('rejects %s, names BANK_URL, never prints the token', (url) => {
    const message = configError({ BANK_TOKEN, BANK_URL: url }).message;
    expect(message).toContain('BANK_URL');
    expect(message).not.toContain(BANK_TOKEN);
  });

  it('keeps accepting a public http BANK_URL when no token is set', () => {
    expect(() => loadConfig(env({ BANK_URL: 'http://bank.example.com' }), REPO_ROOT)).not.toThrow();
  });
});
