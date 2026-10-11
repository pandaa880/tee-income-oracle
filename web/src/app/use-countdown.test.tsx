import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCountdown } from './use-countdown.ts';

const T0 = 1_790_500_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useCountdown', () => {
  it('returns the whole seconds left', () => {
    const { result } = renderHook(() => useCountdown(BigInt(T0 + 581)));
    expect(result.current).toBe(581);
  });

  it('ticks down every second', () => {
    const { result } = renderHook(() => useCountdown(BigInt(T0 + 10)));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(7);
  });

  it('clamps at 0 once the time has passed and stays there', () => {
    const { result } = renderHook(() => useCountdown(BigInt(T0 + 2)));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(0);
  });

  it('is 0 for an expiry already in the past', () => {
    const { result } = renderHook(() => useCountdown(BigInt(T0 - 5)));
    expect(result.current).toBe(0);
  });

  it('is 0 without an expiry', () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current).toBe(0);
  });

  it('stops ticking after unmount', () => {
    const { unmount } = renderHook(() => useCountdown(BigInt(T0 + 10)));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
