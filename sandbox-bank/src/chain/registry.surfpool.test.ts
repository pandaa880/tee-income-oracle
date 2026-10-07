/**
 * The registry reader against a real RPC: an offline embedded surfnet whose accounts are
 * written with the `surfnet_setAccount` cheatcode (no oracle program is deployed; the reader
 * only reads accounts owned by the program id).
 */

import { Surfnet } from '@solana/surfpool';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toHex } from '../crypto/encoding.ts';
import { configAddress, configBytes, entryAddress, entryBytes } from '../testing/registry-bytes.ts';
import { createRpcRegistry, createSolanaRegistryRpc } from './registry.ts';

const PROGRAM_ID = 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8';
const ACTIVE = new Uint8Array(20).fill(0xa1);
const REVOKED = new Uint8Array(20).fill(0xa2);
const UNKNOWN = new Uint8Array(20).fill(0xa3);

let surfnet: Surfnet;

async function setAccount(address: string, data: Uint8Array): Promise<void> {
  const response = await fetch(surfnet.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'surfnet_setAccount',
      params: [address, { lamports: 10_000_000, data: toHex(data), owner: PROGRAM_ID }],
    }),
  });
  const body: unknown = await response.json();
  if (typeof body === 'object' && body !== null && 'error' in body) {
    throw new Error(`surfnet_setAccount failed: ${JSON.stringify(body.error)}`);
  }
}

function registry() {
  return createRpcRegistry({
    rpc: createSolanaRegistryRpc(surfnet.rpcUrl),
    programId: PROGRAM_ID,
    now: () => 1_790_416_800,
  });
}

describe('createRpcRegistry on a surfnet', () => {
  beforeAll(async () => {
    surfnet = Surfnet.start();
    await setAccount(await configAddress(PROGRAM_ID), configBytes({ nextMeasurementId: 2 }));
    await setAccount(
      await entryAddress(PROGRAM_ID, 0),
      entryBytes({ measurementId: 0, attester: REVOKED, revokedAt: 1_790_000_000n }),
    );
    await setAccount(
      await entryAddress(PROGRAM_ID, 1),
      entryBytes({ measurementId: 1, attester: ACTIVE }),
    );
  }, 60_000);

  afterAll(() => {
    surfnet.stop();
  });

  it('finds an active entry written on chain', async () => {
    expect(await registry().isActive(ACTIVE)).toEqual({ ok: true, active: true });
  });

  it('treats a revoked entry as inactive', async () => {
    expect(await registry().isActive(REVOKED)).toEqual({ ok: true, active: false });
  });

  it('treats an unregistered attester as inactive', async () => {
    expect(await registry().isActive(UNKNOWN)).toEqual({ ok: true, active: false });
  });

  it('reports ok:false when the RPC is unreachable', async () => {
    const dead = createRpcRegistry({
      rpc: createSolanaRegistryRpc('http://127.0.0.1:1'),
      programId: PROGRAM_ID,
      now: () => 1_790_416_800,
    });
    expect(await dead.isActive(ACTIVE)).toEqual({ ok: false });
  });
});
