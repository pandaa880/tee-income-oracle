import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitConfirmed } from './confirm.ts';
import type { ChainPort } from '../domain/ports.ts';
import type { SignatureStatus } from '../domain/types.ts';
import { fail, ok } from '../test-support/fakes.ts';

const OPTIONS = { intervalMs: 1000, timeoutMs: 60_000 };

/** A chain whose `signatureStatus` answers from a script, repeating the last entry. */
function scripted(script: readonly (SignatureStatus | null | 'error')[]) {
  let call = 0;
  const signatureStatus = vi.fn<ChainPort['signatureStatus']>(async () => {
    const entry = script[Math.min(call++, script.length - 1)];
    if (entry === 'error') return fail({ code: 'network' });
    return ok(entry ?? null);
  });
  const chain: ChainPort = {
    accounts: vi.fn<ChainPort['accounts']>(async () => ok([])),
    latestBlockhash: vi.fn<ChainPort['latestBlockhash']>(async () => fail({ code: 'network' })),
    signatureStatus,
  };
  return { chain, signatureStatus };
}

const status = (
  confirmationStatus: SignatureStatus['confirmationStatus'],
  err: unknown = null,
): SignatureStatus => ({
  confirmationStatus,
  err,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('waitConfirmed', () => {
  it('polls once immediately and returns confirmed without waiting an interval', async () => {
    const { chain, signatureStatus } = scripted([status('confirmed')]);
    const pending = waitConfirmed(chain, 'sig', {
      ...OPTIONS,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual({ status: 'confirmed' });
    expect(signatureStatus).toHaveBeenCalledTimes(1);
    expect(signatureStatus.mock.calls[0]?.[0]).toBe('sig');
  });

  it('keeps polling every interval until confirmed, treating unknown and processed as not yet', async () => {
    const { chain, signatureStatus } = scripted([null, status('processed'), status('confirmed')]);
    const pending = waitConfirmed(chain, 'sig', {
      ...OPTIONS,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(signatureStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(signatureStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signatureStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ status: 'confirmed' });
    expect(signatureStatus).toHaveBeenCalledTimes(3);
  });

  it('accepts finalized as confirmed', async () => {
    const { chain } = scripted([status('finalized')]);
    const pending = waitConfirmed(chain, 'sig', {
      ...OPTIONS,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual({ status: 'confirmed' });
  });

  it('returns failed with the err when the transaction failed on chain', async () => {
    const err = { InstructionError: [1, { Custom: 6008 }] };
    const { chain } = scripted([status('confirmed', err)]);
    const pending = waitConfirmed(chain, 'sig', {
      ...OPTIONS,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual({ status: 'failed', err });
  });

  it('keeps polling after a failed status request', async () => {
    const { chain } = scripted(['error', 'error', status('confirmed')]);
    const pending = waitConfirmed(chain, 'sig', {
      ...OPTIONS,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ status: 'confirmed' });
  });

  it('times out after timeoutMs when the signature never shows up', async () => {
    const { chain, signatureStatus } = scripted([null]);
    const pending = waitConfirmed(chain, 'sig', {
      ...OPTIONS,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(59_000);
    const callsBefore = signatureStatus.mock.calls.length;
    expect(callsBefore).toBeGreaterThanOrEqual(55);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toEqual({ status: 'timeout' });
    const callsAfter = signatureStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signatureStatus.mock.calls.length).toBe(callsAfter);
  });

  it('honours custom interval and timeout', async () => {
    const { chain, signatureStatus } = scripted([null]);
    const pending = waitConfirmed(chain, 'sig', {
      intervalMs: 10,
      timeoutMs: 50,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ status: 'timeout' });
    expect(signatureStatus.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('stops polling when the signal aborts', async () => {
    const controller = new AbortController();
    const { chain, signatureStatus } = scripted([null]);
    const pending = waitConfirmed(chain, 'sig', { ...OPTIONS, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(2500);
    controller.abort();
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'cancelled' });
    const calls = signatureStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signatureStatus.mock.calls.length).toBe(calls);
  });

  it('times out even when a status request hangs, by aborting that poll at the deadline', async () => {
    vi.useRealTimers();
    // A poll that only ends when its signal aborts, like a stuck fetch.
    const signatureStatus = vi.fn<ChainPort['signatureStatus']>(
      (_sig, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(fail({ code: 'cancelled' })));
        }),
    );
    const chain: ChainPort = {
      accounts: vi.fn<ChainPort['accounts']>(async () => ok([])),
      latestBlockhash: vi.fn<ChainPort['latestBlockhash']>(async () => fail({ code: 'network' })),
      signatureStatus,
    };
    const outcome = await waitConfirmed(chain, 'sig', {
      intervalMs: 10,
      timeoutMs: 50,
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ status: 'timeout' });
  });
});
