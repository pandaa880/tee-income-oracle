import { renderHook, waitFor } from '@testing-library/react';
import type { Address } from '@solana/kit';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { describe, expect, it, vi } from 'vitest';
import { fail } from '../test-support/fakes.ts';
import { queryWrapper } from '../test-support/query.tsx';
import { world, type WorldOptions } from '../test-support/world.ts';
import { useBuilds } from './use-builds.ts';

const REVOKED_AT = 1_790_000_100n;
const entryPda = async (measurementId: number): Promise<Address> =>
  (await findEnclaveEntryPda({ measurementId }))[0];

async function open(options: WorldOptions = {}) {
  const w = await world(options);
  const hook = renderHook(() => useBuilds(w.deps), { wrapper: queryWrapper() });
  return { ...w, ...hook };
}

describe('useBuilds', () => {
  it('lists the two builds of the deployment, newest first, one revoked', async () => {
    const { result } = await open({ verify: { docId: 1 } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((r) => [r.id, r.status])).toEqual([
      [1, 'active'],
      [0, 'revoked'],
    ]);
  });

  it('shows the revocation time and the attester each chain entry holds', async () => {
    const { result } = await open({ verify: { docId: 1 } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [newest, oldest] = result.current.data ?? [];
    expect(newest).toMatchObject({
      attester: '0xb6dda6eed87322334ba37809bd451a852ae6574c',
      registeredAt: 1_790_000_000n,
    });
    expect(oldest).toMatchObject({
      attester: '0xc39b71ae1d2bbc0919ee8c1250728a9b2380052b',
      revokedAt: REVOKED_AT,
    });
  });

  it('marks a build the chain has no entry for as unknown', async () => {
    // The default world registers build 0 only.
    const { result } = await open();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((r) => [r.id, r.status])).toEqual([
      [1, 'unknown'],
      [0, 'active'],
    ]);
  });

  it('marks build 0 revoked when its entry is', async () => {
    const { result } = await open({ revokedAt: REVOKED_AT });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.find((r) => r.id === 0)).toMatchObject({
      status: 'revoked',
      revokedAt: REVOKED_AT,
    });
  });

  it('reads the entries of every listed build in one batch of decoded accounts', async () => {
    const w = await open({ verify: { docId: 1 } });
    await waitFor(() => expect(w.result.current.isSuccess).toBe(true));
    expect(w.chain.accounts).toHaveBeenCalledTimes(1);
    const keys = vi.mocked(w.chain.accounts).mock.calls[0]?.[0] ?? [];
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(expect.arrayContaining([await entryPda(0), await entryPda(1)]));
  });

  it('reads no wallet attestation: it needs no wallet', async () => {
    const w = await open({ verify: { docId: 1 } });
    await waitFor(() => expect(w.result.current.isSuccess).toBe(true));
    expect(w.chain.rawAccounts).not.toHaveBeenCalled();
  });

  it('surfaces a failed read as its AppError', async () => {
    const w = await world({ verify: { docId: 1 } });
    vi.mocked(w.chain.accounts).mockResolvedValue(fail({ code: 'rpc_busy' }));
    const { result } = renderHook(() => useBuilds(w.deps), { wrapper: queryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual({ code: 'rpc_busy' });
  });
});
