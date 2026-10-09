import { renderHook, waitFor } from '@testing-library/react';
import { generateKeyPairSigner, type Address } from '@solana/kit';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { describe, expect, it, vi } from 'vitest';
import { useStatus } from './use-status.ts';
import type { GatewayPort } from '../domain/ports.ts';
import type { ChainAccount } from '../domain/types.ts';
import { fail, fakeChain, fakeDeps, fakeGateway } from '../test-support/fakes.ts';
import { entry } from '../test-support/fixtures.ts';
import { queryWrapper } from '../test-support/query.tsx';

async function deps(gateway: Partial<GatewayPort> = {}, revokedAt = 0n) {
  const key = await generateKeyPairSigner();
  const store = new Map<Address, ChainAccount>([
    [
      (await findEnclaveEntryPda({ measurementId: 0 }))[0],
      { kind: 'enclave_entry', entry: entry({ revokedAt }) },
    ],
  ]);
  return fakeDeps(
    { address: key.address, signIntent: async () => new Uint8Array(64) as never, signer: key },
    fakeChain(store),
    { gateway: fakeGateway(gateway) },
  );
}

describe('useStatus', () => {
  it('is live when the gateway answers and the registry entry is active', async () => {
    const d = await deps();
    const { result } = renderHook(() => useStatus(d), { wrapper: queryWrapper() });
    await waitFor(() => expect(result.current.data).toEqual({ state: 'live', reason: null }));
  });

  it('is down when the registry entry is revoked', async () => {
    const d = await deps({}, 5n);
    const { result } = renderHook(() => useStatus(d), { wrapper: queryWrapper() });
    await waitFor(() =>
      expect(result.current.data).toEqual({ state: 'down', reason: 'enclave_revoked' }),
    );
  });

  it('is down when the gateway is unreachable, and does not need the registry to say so', async () => {
    const d = await deps({
      info: vi.fn<GatewayPort['info']>(async () => fail({ code: 'network' })),
      health: vi.fn<GatewayPort['health']>(async () => fail({ code: 'network' })),
    });
    const { result } = renderHook(() => useStatus(d), { wrapper: queryWrapper() });
    await waitFor(() =>
      expect(result.current.data).toEqual({ state: 'down', reason: 'gateway_unreachable' }),
    );
  });

  it('passes an abort signal to every request so an unmount cancels them', async () => {
    const d = await deps();
    const { result } = renderHook(() => useStatus(d), { wrapper: queryWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(vi.mocked(d.gateway.info).mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });
});
