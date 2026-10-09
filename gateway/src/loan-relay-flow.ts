/**
 * `POST /v1/loans/relay`: the relayer co-signs and pays for a borrower's borrow or
 * repay (FORMATS §16). Order matters for the relayer's SOL: shape check → the
 * borrower's signature → relayer signature (free until sent) → simulate with
 * every signature checked → send → confirm. Fees are spent only after the
 * simulation passed, and a borrower holds at most one relay at a time.
 */
import {
  type Address,
  type KeyPairSigner,
  type Signature,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
} from '@solana/kit';
import { b64Decode } from '@tio/encoding';

import type { RelayChain } from './chain.ts';
import { GatewayError, gatewayError } from './errors.ts';
import {
  type LoanDeployment,
  type LoanTxShape,
  checkLoanTx,
  simulationDetail,
  verifyBorrowerSignature,
} from './loan-relay.ts';
import { CONFIRM_TIMEOUT_MS } from './timeouts.ts';

export type LoanRelayDeps = {
  chain: RelayChain;
  /** The relayer: fee payer and Loan rent payer. */
  payer: KeyPairSigner;
  deployment: LoanDeployment;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type LoanRelay = { relay: (input: { tx_b64: string }) => Promise<{ signature: Signature }> };

/** Relays in progress across all borrowers; each one holds relayer SOL hostage until confirmed. */
export const MAX_IN_FLIGHT = 64;
export const CONFIRM_POLL_MS = 1_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const badTransaction = (rule: number): GatewayError =>
  gatewayError('bad_transaction', 'gateway', 400, { rule });
const txFailed = (): GatewayError => gatewayError('tx_failed', 'chain', 502);

/** Rules 1–11, or `bad_transaction` naming the first rule that failed. */
async function acceptedShape(
  tx_b64: string,
  relayer: Address,
  deployment: LoanDeployment,
): Promise<LoanTxShape> {
  let wire: Uint8Array;
  try {
    wire = b64Decode(tx_b64);
  } catch {
    throw badTransaction(1);
  }
  const checked = await checkLoanTx(wire, relayer, deployment);
  if (!checked.ok) throw badTransaction(checked.rule);
  if (!(await verifyBorrowerSignature(checked.value))) throw badTransaction(11);
  return checked.value;
}

/**
 * Polls until `confirmed`, a cluster error (`tx_failed`) or `CONFIRM_TIMEOUT_MS` (`tx_failed`).
 * A failed poll is not a failed transaction (it may already have landed), so it keeps
 * polling until the deadline. During an RPC outage that holds the borrower's in-flight
 * slot for the deadline plus one poll's RPC timeout, which is the intended bound.
 */
async function confirm(
  chain: RelayChain,
  signature: Signature,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const start = now();
  for (;;) {
    const [status] = await chain.signatureStatuses([signature]).catch(() => [null]);
    if (status !== null && status !== undefined) {
      if (status.err !== null) throw txFailed();
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return;
      }
    }
    if (now() - start >= CONFIRM_TIMEOUT_MS) throw txFailed();
    await sleep(CONFIRM_POLL_MS);
  }
}

/** Any failure talking to the cluster is `tx_failed`; a GatewayError passes through. */
async function chainStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    throw e instanceof GatewayError ? e : txFailed();
  }
}

export function createLoanRelay(deps: LoanRelayDeps): LoanRelay {
  const relayer = deps.payer.address;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const inFlight = new Set<Address>();

  async function coSignAndSend(shape: LoanTxShape): Promise<Signature> {
    const signed = await partiallySignTransaction([deps.payer.keyPair], shape.tx);
    const wire = getBase64EncodedWireTransaction(signed);
    const { err } = await chainStep(() => deps.chain.simulate(wire));
    if (err !== null) throw gatewayError('simulation_failed', 'chain', 409, simulationDetail(err));
    const signature = await chainStep(() => deps.chain.send(wire));
    await chainStep(() => confirm(deps.chain, signature, now, sleep));
    return signature;
  }

  return {
    relay: async ({ tx_b64 }) => {
      const shape = await acceptedShape(tx_b64, relayer, deps.deployment);
      if (inFlight.has(shape.borrower) || inFlight.size >= MAX_IN_FLIGHT) {
        throw gatewayError('relay_in_flight', 'gateway', 429);
      }
      inFlight.add(shape.borrower);
      try {
        return { signature: await coSignAndSend(shape) };
      } finally {
        inFlight.delete(shape.borrower);
      }
    },
  };
}
