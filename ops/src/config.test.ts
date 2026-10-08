import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const ORACLE = 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8';

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    SOLANA_RPC_URL: 'http://127.0.0.1:8899',
    SOLANA_WS_URL: 'ws://127.0.0.1:8900',
    ADMIN_KEYPAIR: '/keys/admin.json',
    ORACLE_PROGRAM_ID: ORACLE,
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('loads a complete environment', () => {
    expect(loadConfig(env())).toEqual({
      rpcUrl: 'http://127.0.0.1:8899',
      wsUrl: 'ws://127.0.0.1:8900',
      adminKeypairPath: '/keys/admin.json',
      oracleProgramId: ORACLE,
    });
  });

  it('accepts https and wss urls', () => {
    const config = loadConfig(
      env({
        SOLANA_RPC_URL: 'https://api.devnet.solana.com',
        SOLANA_WS_URL: 'wss://api.devnet.solana.com',
      }),
    );
    expect(config.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(config.wsUrl).toBe('wss://api.devnet.solana.com');
  });

  it('defaults the admin keypair under the home directory', () => {
    const config = loadConfig(env({ ADMIN_KEYPAIR: undefined }));
    expect(config.adminKeypairPath).toBe(`${homedir()}/.config/solana/tee-income-oracle.json`);
  });

  it('expands ~ in the admin keypair path', () => {
    const config = loadConfig(env({ ADMIN_KEYPAIR: '~/keys/admin.json' }));
    expect(config.adminKeypairPath).toBe(`${homedir()}/keys/admin.json`);
  });

  it.each(['SOLANA_RPC_URL', 'SOLANA_WS_URL', 'ORACLE_PROGRAM_ID'])(
    'rejects a missing %s naming the key',
    (key) => {
      expect(() => loadConfig(env({ [key]: undefined }))).toThrow(new RegExp(key));
    },
  );

  it('rejects a non-url SOLANA_RPC_URL naming the key', () => {
    expect(() => loadConfig(env({ SOLANA_RPC_URL: 'not a url' }))).toThrow(/SOLANA_RPC_URL/);
  });

  it('rejects a non-url SOLANA_WS_URL naming the key', () => {
    expect(() => loadConfig(env({ SOLANA_WS_URL: 'not a url' }))).toThrow(/SOLANA_WS_URL/);
  });

  it('rejects an http SOLANA_WS_URL naming the key', () => {
    expect(() => loadConfig(env({ SOLANA_WS_URL: 'http://127.0.0.1:8900' }))).toThrow(
      /SOLANA_WS_URL/,
    );
  });

  it('rejects a ws SOLANA_RPC_URL naming the key', () => {
    expect(() => loadConfig(env({ SOLANA_RPC_URL: 'ws://127.0.0.1:8900' }))).toThrow(
      /SOLANA_RPC_URL/,
    );
  });

  it('rejects a non-base58 ORACLE_PROGRAM_ID naming the key', () => {
    expect(() => loadConfig(env({ ORACLE_PROGRAM_ID: '0OIl-not-base58' }))).toThrow(
      /ORACLE_PROGRAM_ID/,
    );
  });

  it('rejects a base58 ORACLE_PROGRAM_ID of the wrong length naming the key', () => {
    expect(() => loadConfig(env({ ORACLE_PROGRAM_ID: 'abc' }))).toThrow(/ORACLE_PROGRAM_ID/);
  });
});
