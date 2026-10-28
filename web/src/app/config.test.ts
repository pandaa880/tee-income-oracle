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
  enclaves: { measurement_id: number }[];
};

const GOOD = {
  VITE_GATEWAY_URL: 'https://gateway.example.com',
  VITE_RPC_URL: 'https://api.devnet.solana.com',
  VITE_CLUSTER: 'devnet',
};

describe('loadConfig', () => {
  it('parses a valid environment', async () => {
    const config = await loadConfig(GOOD);
    expect(config.gatewayUrl).toBe('https://gateway.example.com');
    expect(config.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(config.cluster).toBe('devnet');
  });

  it('loads the bundled deployment for the cluster', async () => {
    const { deployment } = await loadConfig(GOOD);
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

  it('switches both the loan book and the verify page on', async () => {
    expect((await loadConfig(GOOD)).features).toEqual({ verify: true, book: true });
  });

  it('parses the deployment file for the verifier too (program ids checked, enclave records kept)', async () => {
    const { verifier } = await loadConfig(GOOD);
    expect(verifier.oracleProgram).toBe(devnet.oracle_program);
    expect(verifier.enclaves.map((e) => e.measurementId)).toEqual(
      devnet.enclaves.map((e) => e.measurement_id),
    );
  });

  it('rejects a bundled sas_signer that is not the oracle PDA', async () => {
    const tampered = { ...devnet, sas_signer: devnet.oracle_program };
    await expect(loadConfig(GOOD, tampered)).rejects.toThrow(/sas_signer/);
  });

  it('allows plain http only for localhost', async () => {
    const local = await loadConfig({
      ...GOOD,
      VITE_GATEWAY_URL: 'http://localhost:8082',
      VITE_RPC_URL: 'http://localhost:8899',
    });
    expect(local.gatewayUrl).toBe('http://localhost:8082');
    await expect(
      loadConfig({ ...GOOD, VITE_GATEWAY_URL: 'http://gateway.example.com' }),
    ).rejects.toThrow(/VITE_GATEWAY_URL/);
    await expect(loadConfig({ ...GOOD, VITE_RPC_URL: 'http://rpc.example.com' })).rejects.toThrow(
      /VITE_RPC_URL/,
    );
  });

  it.each(['VITE_GATEWAY_URL', 'VITE_RPC_URL', 'VITE_CLUSTER'] as const)(
    'names %s when it is missing',
    async (name) => {
      const env: Record<string, string | undefined> = { ...GOOD };
      delete env[name];
      await expect(loadConfig(env)).rejects.toThrow(new RegExp(name));
    },
  );

  it('rejects a URL that is not a URL and an unknown cluster, naming the variable', async () => {
    await expect(loadConfig({ ...GOOD, VITE_GATEWAY_URL: 'not a url' })).rejects.toThrow(
      /VITE_GATEWAY_URL/,
    );
    await expect(loadConfig({ ...GOOD, VITE_CLUSTER: 'mainnet-beta' })).rejects.toThrow(
      /VITE_CLUSTER/,
    );
  });
});
