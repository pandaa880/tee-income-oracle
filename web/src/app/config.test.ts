// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const devnet = JSON.parse(
  readFileSync(new URL('../../../deployments/devnet.json', import.meta.url), 'utf8'),
) as {
  mint: string;
  credential: string;
  schema: string;
  sas_signer: string;
  oracle_program: string;
  pools: { address: string; pool_id: number }[];
};

const GOOD = {
  VITE_GATEWAY_URL: 'https://gateway.example.com',
  VITE_RPC_URL: 'https://api.devnet.solana.com',
  VITE_CLUSTER: 'devnet',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(GOOD);
    expect(config.gatewayUrl).toBe('https://gateway.example.com');
    expect(config.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(config.cluster).toBe('devnet');
  });

  it('loads the bundled deployment for the cluster', () => {
    const { deployment } = loadConfig(GOOD);
    expect(deployment).toMatchObject({
      mint: devnet.mint,
      credential: devnet.credential,
      schema: devnet.schema,
      sasSigner: devnet.sas_signer,
      oracleProgram: devnet.oracle_program,
    });
    expect(deployment.pools).toEqual(
      devnet.pools.map((p) => ({ address: p.address, poolId: p.pool_id })),
    );
  });

  it('keeps the verify page and the loan book switched off', () => {
    expect(loadConfig(GOOD).features).toEqual({ verify: false, book: false });
  });

  it('allows plain http only for localhost', () => {
    expect(
      loadConfig({
        ...GOOD,
        VITE_GATEWAY_URL: 'http://localhost:8082',
        VITE_RPC_URL: 'http://localhost:8899',
      }).gatewayUrl,
    ).toBe('http://localhost:8082');
    expect(() => loadConfig({ ...GOOD, VITE_GATEWAY_URL: 'http://gateway.example.com' })).toThrow(
      /VITE_GATEWAY_URL/,
    );
    expect(() => loadConfig({ ...GOOD, VITE_RPC_URL: 'http://rpc.example.com' })).toThrow(
      /VITE_RPC_URL/,
    );
  });

  it.each(['VITE_GATEWAY_URL', 'VITE_RPC_URL', 'VITE_CLUSTER'] as const)(
    'names %s when it is missing',
    (name) => {
      const env: Record<string, string | undefined> = { ...GOOD };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(new RegExp(name));
    },
  );

  it('rejects a URL that is not a URL and an unknown cluster, naming the variable', () => {
    expect(() => loadConfig({ ...GOOD, VITE_GATEWAY_URL: 'not a url' })).toThrow(
      /VITE_GATEWAY_URL/,
    );
    expect(() => loadConfig({ ...GOOD, VITE_CLUSTER: 'mainnet-beta' })).toThrow(/VITE_CLUSTER/);
  });
});
