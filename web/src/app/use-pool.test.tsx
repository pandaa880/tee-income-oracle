import { renderHook, waitFor } from '@testing-library/react';
import { generateKeyPairSigner, type Address } from '@solana/kit';
import { findLoanPda, findVaultPda, getLoanDecoder } from '@tio/demo-pool-client';
import { describe, expect, it, vi } from 'vitest';
import { usePool } from './use-pool.ts';
import type { ChainAccount } from '../domain/types.ts';
import { fail, fakeChain, fakeDeps } from '../test-support/fakes.ts';
import { loanBytes, pool, POOL_0, tokenAccount } from '../test-support/fixtures.ts';
import { queryWrapper } from '../test-support/query.tsx';

async function world(options: { vault?: boolean; pool?: boolean; loan?: boolean } = {}) {
  const key = await generateKeyPairSigner();
  const [vaultAddress] = await findVaultPda({ pool: POOL_0 });
  const [loanAddress] = await findLoanPda({ pool: POOL_0, borrower: key.address });
  const store = new Map<Address, ChainAccount>();
  if (options.pool !== false) store.set(POOL_0, { kind: 'pool', pool: pool() });
  if (options.vault !== false) {
    store.set(vaultAddress, { kind: 'token', token: tokenAccount({ amount: 9_000_000n }) });
  }
  if (options.loan === true) {
    store.set(loanAddress, {
      kind: 'loan',
      loan: getLoanDecoder().decode(loanBytes(key.address, 2_500_000n)),
    });
  }
  const deps = fakeDeps(
    { address: key.address, signIntent: async () => new Uint8Array(64) as never, signer: key },
    fakeChain(store),
  );
  return { deps, wallet: key.address, vaultAddress, loanAddress };
}

const render = (w: Awaited<ReturnType<typeof world>>) =>
  renderHook(() => usePool(POOL_0, w.wallet, w.deps), { wrapper: queryWrapper() });

describe('usePool', () => {
  it('reads the pool, the vault balance and no loan', async () => {
    const w = await world();
    const { result } = render(w);
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toMatchObject({
      pool: { poolId: 0 },
      vault: 9_000_000n,
      loan: null,
    });
  });

  it('includes the open loan of the wallet', async () => {
    const w = await world({ loan: true });
    const { result } = render(w);
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.loan).toMatchObject({ amount: 2_500_000n, borrower: w.wallet });
  });

  it('reads pool, vault and loan in one accounts call, in that order', async () => {
    const w = await world();
    const { result } = render(w);
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(w.deps.chain.accounts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(w.deps.chain.accounts).mock.calls[0]?.[0]).toEqual([
      POOL_0,
      w.vaultAddress,
      w.loanAddress,
    ]);
  });

  it.each([
    ['the vault is missing', { vault: false }],
    ['the pool is missing', { pool: false }],
  ])('is a protocol_error when %s', async (_, options) => {
    const w = await world(options);
    const { result } = render(w);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: 'protocol_error' });
  });

  it('surfaces a chain error as the query error', async () => {
    const w = await world();
    vi.mocked(w.deps.chain.accounts).mockResolvedValue(fail({ code: 'rpc_busy' }));
    const { result } = render(w);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: 'rpc_busy' });
  });
});
