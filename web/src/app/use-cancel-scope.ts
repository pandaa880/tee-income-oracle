import { useCallback, useEffect, useRef } from 'react';

export type CancelScope = {
  /** A signal for one call: aborts on unmount, on `cancel()` or after `timeoutMs`. */
  next: () => AbortSignal;
  /** Aborts every call started so far; later calls get a fresh signal. */
  cancel: () => void;
};

/**
 * Per-call abort signals owned by a component. The controller is created in the effect, so
 * StrictMode's dev remount gets a fresh one, not an already-aborted one.
 */
export function useCancelScope(timeoutMs: number): CancelScope {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current = new AbortController();
    // Abort the controller in use at unmount: cancel() may have swapped it since mount.
    return () => controller.current?.abort();
  }, []);
  const next = useCallback(() => {
    controller.current ??= new AbortController();
    return AbortSignal.any([controller.current.signal, AbortSignal.timeout(timeoutMs)]);
  }, [timeoutMs]);
  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = new AbortController();
  }, []);
  return { next, cancel };
}
