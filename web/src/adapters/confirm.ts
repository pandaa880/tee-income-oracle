// Polls a signature until it is confirmed (no websockets: one less thing to keep alive).
import { sleep } from './sleep.ts';
import type { ChainPort } from '../domain/ports.ts';

export type ConfirmOutcome =
  | { status: 'confirmed' }
  | { status: 'failed'; err: unknown }
  | { status: 'timeout' }
  | { status: 'cancelled' };

export type ConfirmOptions = { intervalMs: number; timeoutMs: number; signal: AbortSignal };

/**
 * Polls now, then every `intervalMs`, until `confirmed`/`finalized`, an on-chain error, the
 * deadline or an abort. `processed`, unknown and a failed status request all mean "not yet".
 */
export async function waitConfirmed(
  chain: ChainPort,
  signature: string,
  { intervalMs, timeoutMs, signal }: ConfirmOptions,
): Promise<ConfirmOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) return { status: 'cancelled' };
    // Each poll is bounded by the deadline too, so a hung RPC call can't outlast timeoutMs.
    const remaining = Math.max(deadline - Date.now(), 0);
    const poll = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    const reply = await chain.signatureStatus(signature, poll);
    if (signal.aborted) return { status: 'cancelled' };
    const status = reply.ok ? reply.value : null;
    if (status !== null && status.err !== null) return { status: 'failed', err: status.err };
    if (status !== null && status.confirmationStatus !== 'processed')
      return { status: 'confirmed' };
    if (Date.now() >= deadline) return { status: 'timeout' };
    await sleep(intervalMs, signal);
  }
}
