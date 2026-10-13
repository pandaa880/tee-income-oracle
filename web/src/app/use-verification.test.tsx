import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

import { findEnclaveEntryPda } from '@tio/oracle-client';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { explorerAddressUrl } from '../domain/explorer.ts';
import { fail, CONFIG } from '../test-support/fakes.ts';
import { queryWrapper } from '../test-support/query.tsx';
import { type WorldOptions, verifiedOf, world } from '../test-support/world.ts';
import { useVerification } from './use-verification.ts';

// The real verifier runs here (P-384 chain, COSE, image id) over the archived document 1.
vi.setConfig({ testTimeout: 30_000 });
const SLOW = { timeout: 20_000 };
const REVOKED_AT = 1_790_000_100n;

async function open(options: WorldOptions = {}) {
  const w = await world({ verify: { docId: 1 }, ...options });
  const hook = renderHook(() => useVerification(w.wallet, w.deps), { wrapper: queryWrapper() });
  return { ...w, ...hook };
}

const failedIds = (checks: readonly { id: string; status: string }[]) =>
  checks.filter((c) => c.status === 'fail').map((c) => c.id);

describe('useVerification', () => {
  it('passes all seven checks for the real document 1 and a matching registry entry', async () => {
    const { result } = await open();
    await waitFor(() => expect(result.current.isSuccess).toBe(true), SLOW);
    const view = result.current.data;
    expect(view?.headline).toBe('Build #1 · 7 of 7 checks pass');
    expect(view?.verdict).toBe('PASS');
    expect(view?.checks.map((c) => c.status)).toEqual(Array(7).fill('pass'));
  });

  it('shows the facts of the attestation it read and the registry entry link', async () => {
    const w = await open();
    await waitFor(() => expect(w.result.current.isSuccess).toBe(true), SLOW);
    const { attestationAddress, entryAddress, issuedAt, expiry } = verifiedOf(w);
    const [expectedEntry] = await findEnclaveEntryPda({ measurementId: 1 });
    expect(entryAddress).toBe(expectedEntry);
    const view = w.result.current.data;
    expect(view?.facts).toMatchObject({
      attestation: attestationAddress,
      build: 1,
      expired: false,
    });
    expect(view?.tier.letter).toBe('A');
    expect(view?.links.entry).toBe(explorerAddressUrl('devnet', expectedEntry));
    expect(issuedAt).toBeLessThan(expiry);
  });

  it('reads the wallet attestation and the entry as raw accounts through the chain port', async () => {
    const w = await open();
    await waitFor(() => expect(w.result.current.isSuccess).toBe(true), SLOW);
    const { attestationAddress, entryAddress } = verifiedOf(w);
    const read = vi.mocked(w.chain.rawAccounts).mock.calls.flatMap(([keys]) => keys);
    expect(read).toEqual([attestationAddress, entryAddress]);
  });

  it('fails only the entry_active check for a revoked entry', async () => {
    const { result } = await open({ verify: { docId: 1, entry: { revokedAt: REVOKED_AT } } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true), SLOW);
    const view = result.current.data;
    expect(failedIds(view?.checks ?? [])).toEqual(['entry_active']);
    expect(view?.checks.find((c) => c.id === 'entry_active')?.detail).toMatch(/^revoked at /);
    expect(view?.headline).toBe('Build #1 · 6 of 7 checks pass');
    expect(view?.verdict).toBe('FAIL');
  });

  it('fails only the compose_pcr16 check when GitHub serves other compose bytes', async () => {
    const { result } = await open({ verify: { docId: 1, compose: 'wrong' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true), SLOW);
    expect(failedIds(result.current.data?.checks ?? [])).toEqual(['compose_pcr16']);
    expect(result.current.data?.verdict).toBe('FAIL');
  });

  it('fails the verdict, with 7 of 7 checks, for an attestation another signer wrote', async () => {
    const { result } = await open({ verify: { docId: 1, signer: CONFIG.deployment.authority } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true), SLOW);
    const view = result.current.data;
    expect(view?.headline).toBe('Build #1 · 7 of 7 checks pass');
    expect(view?.verdict).toBe('FAIL');
    expect(view?.verdictNote).toMatch(/not written by the oracle's signer/);
  });

  it('is verify_failed / attestation_missing for a wallet without an attestation', async () => {
    const { result } = await open({ attestation: false });
    await waitFor(() => expect(result.current.isError).toBe(true), SLOW);
    expect(result.current.error).toEqual({ code: 'verify_failed', reason: 'attestation_missing' });
  });

  it('is verify_failed / fetch_failed when the compose source cannot be reached', async () => {
    const { result } = await open({ verify: { docId: 1, compose: 'unreachable' } });
    await waitFor(() => expect(result.current.isError).toBe(true), SLOW);
    expect(result.current.error).toEqual({ code: 'verify_failed', reason: 'fetch_failed' });
  });

  it('is verify_failed / entry_missing when the registry has no entry for the build', async () => {
    const w = await world({ verify: { docId: 1 } });
    w.raw.delete(verifiedOf(w).entryAddress);
    const { result } = renderHook(() => useVerification(w.wallet, w.deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true), SLOW);
    expect(result.current.error).toEqual({ code: 'verify_failed', reason: 'entry_missing' });
  });

  it('is verify_failed / deployment_malformed when the deployment lists no record for the build', async () => {
    const { result } = await open({
      overrides: { config: { ...CONFIG, verifier: { ...CONFIG.verifier, enclaves: [] } } },
    });
    await waitFor(() => expect(result.current.isError).toBe(true), SLOW);
    expect(result.current.error).toEqual({
      code: 'verify_failed',
      reason: 'deployment_malformed',
    });
  });

  it('keeps an RPC failure as its own AppError, not a verify_failed', async () => {
    const w = await world({ verify: { docId: 1 } });
    vi.mocked(w.chain.rawAccounts).mockResolvedValue(fail({ code: 'rpc_busy' }));
    const { result } = renderHook(() => useVerification(w.wallet, w.deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true), SLOW);
    expect(result.current.error).toEqual({ code: 'rpc_busy' });
  });

  it('gives up with timeout, not cancelled, when the chain has not answered after 30 s', async () => {
    vi.useFakeTimers();
    try {
      const w = await world({ verify: { docId: 1 } });
      // A read that never settles and ignores its signal: the deadline alone must end it.
      vi.mocked(w.chain.rawAccounts).mockImplementation(() => new Promise(() => undefined));
      const { result } = renderHook(() => useVerification(w.wallet, w.deps), {
        wrapper: queryWrapper(),
      });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(result.current.isError).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      vi.useRealTimers();
      await waitFor(() => expect(result.current.isError).toBe(true), SLOW);
      expect(result.current.error).toEqual({ code: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is cancelled, not timeout, when a read fails with cancelled before the deadline', async () => {
    const w = await world({ verify: { docId: 1 } });
    vi.mocked(w.chain.rawAccounts).mockResolvedValue(fail({ code: 'cancelled' }));
    const { result } = renderHook(() => useVerification(w.wallet, w.deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true), SLOW);
    expect(result.current.error).toEqual({ code: 'cancelled' });
  });

  it('does not fetch anything without a wallet', async () => {
    const w = await world({ verify: { docId: 1 } });
    const { result } = renderHook(() => useVerification(undefined, w.deps), {
      wrapper: queryWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
    expect(w.chain.rawAccounts).not.toHaveBeenCalled();
  });

  it('does not retry a failed verification on its own, even when the client would', async () => {
    const w = await world({ verify: { docId: 1 }, attestation: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useVerification(w.wallet, w.deps), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true), SLOW);
    expect(w.chain.rawAccounts).toHaveBeenCalledTimes(1);
  });
});
