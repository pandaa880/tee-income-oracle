import { useEffect, useState } from 'react';

const secondsLeft = (expiresAt: bigint | null, nowMs: number): number =>
  expiresAt === null ? 0 : Math.max(0, Number(expiresAt) - Math.floor(nowMs / 1000));

/**
 * Whole seconds until `expiresAt` (unix seconds), stopping at 0. Derived from the clock at each
 * render, so the first frame is already right; the interval only asks for a re-render each second.
 */
export function useCountdown(expiresAt: bigint | null): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (expiresAt === null) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return secondsLeft(expiresAt, Date.now());
}
