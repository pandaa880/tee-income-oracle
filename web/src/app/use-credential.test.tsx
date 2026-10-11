import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { generateKeyPairSigner, type Address } from '@solana/kit';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress, parseSasAttestation, SAS_PROGRAM_ID } from '@tio/oracle-client/attest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from './deps.ts';
import { type CredentialOptions, useCredential } from './use-credential.ts';
import type { BorrowerSigner } from '../domain/ports.ts';
import type { ChainAccount } from '../domain/types.ts';
import { fail, fakeChain, fakeDeps } from '../test-support/fakes.ts';
import {
  CREDENTIAL,
  entry,
  NOW,
  OTHER,
  POLICY_HASH,
  pool,
  POOL_0,
  payloadBytes,
  SAS_SIGNER,
  SCHEMA,
  sasAccountBytes,
} from '../test-support/fixtures.ts';
import { queryWrapper } from '../test-support/query.tsx';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Number(NOW) * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

async function world(
  options: { attestation?: boolean; signer?: Address; policy?: Uint8Array } = {},
) {
  const key = await generateKeyPairSigner();
  const wallet = key.address;
  const store = new Map<Address, ChainAccount>();
  store.set(POOL_0, { kind: 'pool', pool: pool({ policyHash: options.policy ?? POLICY_HASH }) });
  store.set((await findEnclaveEntryPda({ measurementId: 0 }))[0], {
    kind: 'enclave_entry',
    entry: entry(),
  });
  if (options.attestation !== false) {
    const bytes = sasAccountBytes({ wallet, signer: options.signer ?? SAS_SIGNER });
    store.set(await attestationAddress(CREDENTIAL, SCHEMA, wallet), {
      kind: 'attestation',
      attestation: parseSasAttestation(SAS_PROGRAM_ID, bytes),
    });
  }
  const signer: BorrowerSigner = {
    address: wallet,
    signIntent: async () => new Uint8Array(64) as never,
    signer: key,
  };
  return { wallet, deps: fakeDeps(signer, fakeChain(store)) };
}

const accountCalls = (deps: Deps) => vi.mocked(deps.chain.accounts).mock.calls.length;

async function renderPolling(poll: CredentialOptions['poll']) {
  vi.useFakeTimers();
  vi.setSystemTime(Number(NOW) * 1000);
  const { wallet, deps } = await world();
  const options = poll === undefined ? undefined : { poll };
  const { result } = renderHook(() => useCredential(wallet, POOL_0, deps, options), {
    wrapper: queryWrapper(),
  });
  // The first read is two chain calls (attestation + pool, then the registry entry) behind
  // real async PDA derivation. The interval is scheduled when the query settles, so wait for
  // the settled result, not just the calls, before measuring.
  await act(async () => {
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
  return deps;
}

describe('useCredential', () => {
  it('reports valid for a fresh attestation from the oracle signer', async () => {
    const { wallet, deps } = await world();
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('valid'));
  });

  it('reports none when the wallet has no attestation', async () => {
    const { wallet, deps } = await world({ attestation: false });
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('none'));
  });

  it('reports foreign_signer for an attestation signed by someone else', async () => {
    const { wallet, deps } = await world({ signer: OTHER });
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('foreign_signer'));
  });

  it('reports policy_mismatch when the lender changed its policy hash', async () => {
    const { wallet, deps } = await world({ policy: new Uint8Array(32).fill(0x99) });
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('policy_mismatch'));
  });

  it('reads the registry entry of the payload measurement id, not a default one', async () => {
    const key = await generateKeyPairSigner();
    const store = new Map<Address, ChainAccount>([
      [POOL_0, { kind: 'pool', pool: pool() }],
      // Only entry 1 exists: reading entry 0 would give enclave_revoked/not_approved.
      [
        (await findEnclaveEntryPda({ measurementId: 1 }))[0],
        { kind: 'enclave_entry', entry: entry({ measurementId: 1 }) },
      ],
      [
        await attestationAddress(CREDENTIAL, SCHEMA, key.address),
        {
          kind: 'attestation',
          attestation: parseSasAttestation(
            SAS_PROGRAM_ID,
            sasAccountBytes({ wallet: key.address, payload: payloadBytes({ measurementId: 1 }) }),
          ),
        },
      ],
    ]);
    const signer = {
      address: key.address,
      signIntent: async () => new Uint8Array(64) as never,
      signer: key,
    };
    const deps = fakeDeps(signer, fakeChain(store));
    const { result } = renderHook(() => useCredential(key.address, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('valid'));
  });

  it('surfaces a chain error as the query error (the AppError object), not as a status', async () => {
    const { wallet, deps } = await world();
    vi.mocked(deps.chain.accounts).mockResolvedValue(fail({ code: 'rpc_busy' }));
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: 'rpc_busy' });
    expect(result.current.data).toBeUndefined();
  });

  it('returns the decoded record and the pool limit of the payload tier', async () => {
    const { wallet, deps } = await world();
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('valid'));
    expect(result.current.data?.limit).toBe(5_000_000n);
    expect(result.current.data?.record).toMatchObject({
      payload: { tier: 1 },
      expiry: NOW + 10_000n,
    });
  });

  it('has no record and a zero limit when the wallet has no attestation', async () => {
    const { wallet, deps } = await world({ attestation: false });
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('none'));
    expect(result.current.data).toMatchObject({ record: null, limit: 0n });
  });

  it('reads afresh when the epoch changes, without waiting for a poll', async () => {
    const { wallet, deps } = await world();
    const { result, rerender } = renderHook(
      ({ epoch }: { epoch: string }) => useCredential(wallet, POOL_0, deps, { epoch }),
      { wrapper: queryWrapper(), initialProps: { epoch: 'a' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const before = accountCalls(deps);
    rerender({ epoch: 'b' });
    await waitFor(() => expect(accountCalls(deps)).toBeGreaterThan(before));
  });

  it('seeds the shared credential key with an epoch read, so other pages see it', async () => {
    const { wallet, deps } = await world();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps, { epoch: 'e1' }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(['credential', 'devnet', wallet, POOL_0])).toBe(result.current.data);
  });

  describe('polling', () => {
    it('refetches about every 3 s with poll: true', async () => {
      const deps = await renderPolling(true);
      const before = accountCalls(deps);
      expect(before).toBeGreaterThan(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
        // The refetch derives the PDA on real time before it calls the chain.
        await vi.waitFor(() => expect(accountCalls(deps)).toBeGreaterThan(before));
      });
    });

    it('polls while the predicate holds for the latest read, then stops', async () => {
      const seen: (string | undefined)[] = [];
      const deps = await renderPolling((latest) => {
        seen.push(latest?.status);
        return latest === undefined;
      });
      const before = accountCalls(deps);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(seen).toContain('valid');
      expect(accountCalls(deps)).toBe(before);
    });

    it('keeps polling while the predicate holds', async () => {
      const deps = await renderPolling(() => true);
      const before = accountCalls(deps);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
        // The refetch derives the PDA on real time before it calls the chain.
        await vi.waitFor(() => expect(accountCalls(deps)).toBeGreaterThan(before));
      });
    });

    it.each([false, undefined])('does not refetch on its own with poll: %s', async (poll) => {
      const deps = await renderPolling(poll);
      const before = accountCalls(deps);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(accountCalls(deps)).toBe(before);
    });
  });
});
