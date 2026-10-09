// Test code only. A scripted RelayChain and a fake LoanRelay.
import { type Base64EncodedWireTransaction, type Signature, signature } from '@solana/kit';

import type { RelayChain } from '../chain.ts';
import type { LoanRelay } from '../loan-relay-flow.ts';

type Status = { err: unknown; confirmationStatus: string | null } | null;

export const SENT_SIGNATURE: Signature = signature('1'.repeat(64)); // 64 zero bytes in base58
export const CONFIRMED: Status = { err: null, confirmationStatus: 'confirmed' };

export type RelayScript = {
  /** `simulate` resolves `{ err }`; default null (the transaction would succeed). */
  simulateErr?: unknown;
  /** `simulate` rejects with this (the RPC itself failed). */
  simulateError?: Error;
  /** `send` rejects with this instead of returning `SENT_SIGNATURE`. */
  sendError?: Error;
  /** One entry per `signatureStatuses` poll (an Error entry makes that poll reject); the last entry repeats. Default: confirmed at once. */
  statuses?: readonly (Status | Error)[];
  /** `simulate` waits for this before answering (to hold a relay in flight). */
  gate?: Promise<void>;
};

export type FakeRelayChain = RelayChain & {
  calls: { simulate: string[]; send: string[]; statuses: number };
  /** Resolves once `simulate` has been called `n` times. */
  simulations: (n: number) => Promise<void>;
};

export function fakeRelayChain(script: RelayScript = {}): FakeRelayChain {
  const calls = { simulate: [] as string[], send: [] as string[], statuses: 0 };
  const waiters: { n: number; resolve: () => void }[] = [];
  const statuses = script.statuses ?? [CONFIRMED];
  return {
    calls,
    simulations: (n) =>
      calls.simulate.length >= n
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ n, resolve })),
    simulate: async (wire: Base64EncodedWireTransaction) => {
      calls.simulate.push(wire);
      for (const w of waiters) if (calls.simulate.length >= w.n) w.resolve();
      await script.gate;
      if (script.simulateError !== undefined) throw script.simulateError;
      return { err: script.simulateErr ?? null };
    },
    send: async (wire: Base64EncodedWireTransaction) => {
      calls.send.push(wire);
      if (script.sendError !== undefined) throw script.sendError;
      return SENT_SIGNATURE;
    },
    signatureStatuses: async (sigs) => {
      const at = Math.min(calls.statuses, statuses.length - 1);
      calls.statuses += 1;
      const entry = statuses[at] ?? null;
      if (entry instanceof Error) throw entry;
      return sigs.map(() => entry);
    },
  };
}

export type FakeLoanRelay = LoanRelay & { calls: { tx_b64: string }[] };

/** Answers `{ signature }`, or runs `behaviour` (e.g. to throw a GatewayError). */
export function fakeLoanRelay(
  behaviour?: (input: { tx_b64: string }) => Promise<never>,
): FakeLoanRelay {
  const calls: { tx_b64: string }[] = [];
  return {
    calls,
    relay: async (input) => {
      calls.push(input);
      if (behaviour !== undefined) return behaviour(input);
      return { signature: SENT_SIGNATURE };
    },
  };
}
