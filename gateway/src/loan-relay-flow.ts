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
  getSignatureFromTransaction,
  partiallySignTransaction,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
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
import { type SponsorshipBudget, createSponsorshipBudget } from './sponsorship.ts';
import { CONFIRM_TIMEOUT_MS } from './timeouts.ts';

export type LoanRelayDeps = {
  chain: RelayChain;
  /** The relayer: fee payer and Loan rent payer. */
  payer: KeyPairSigner;
  deployment: LoanDeployment;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Token-account rent budget; default `createSponsorshipBudget` (once per wallet, 20 per hour). */
  sponsorship?: SponsorshipBudget;
};

export type LoanRelay = { relay: (input: { tx_b64: string }) => Promise<{ signature: Signature }> };

/** Relays in progress across all borrowers; each one holds relayer SOL hostage until confirmed. */
export const MAX_IN_FLIGHT = 64;
export const CONFIRM_POLL_MS = 1_000;
/**
 * A `sendTransaction` whose reply is lost (timeout, reset) may still have reached the
 * node, and the loan may land. The signature is ours to derive from the signed bytes,
 * so the flow looks for it this long before calling the relay failed.
 */
export const SEND_ERROR_GRACE_MS = 15_000;

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
  deadlineMs = CONFIRM_TIMEOUT_MS,
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
    if (now() - start >= deadlineMs) throw txFailed();
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
  const sponsorship = deps.sponsorship ?? createSponsorshipBudget({ now });
  const inFlight = new Set<Address>();

  /**
   * A borrow creates the borrower's token account when it is missing, at the relayer's
   * expense (FORMATS §16 → Relay). That rent is the one cost a borrower can make the
   * relayer pay again (close the account after repay, borrow again). Two guards: a
   * missing account whose address already has transaction history was created and
   * closed before, so it is never funded again (chain state, survives a restart); and
   * first-time accounts draw on the hourly budget.
   */
  async function needsSponsoredAta(shape: LoanTxShape): Promise<boolean> {
    if (shape.kind !== 'borrow') return false;
    const [ata] = await findAssociatedTokenPda({
      owner: shape.borrower,
      mint: deps.deployment.mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    if ((await chainStep(() => deps.chain.account(ata))) !== null) return false;
    if (await chainStep(() => deps.chain.hasHistory(ata))) {
      throw gatewayError('sponsorship_exhausted', 'gateway', 429);
    }
    return true;
  }

  async function coSignAndSend(shape: LoanTxShape): Promise<Signature> {
    const fundsAta = await needsSponsoredAta(shape);
    if (fundsAta && !sponsorship.available(shape.borrower)) {
      throw gatewayError('sponsorship_exhausted', 'gateway', 429);
    }
    const signed = await partiallySignTransaction([deps.payer.keyPair], shape.tx);
    const wire = getBase64EncodedWireTransaction(signed);
    const { err } = await chainStep(() => deps.chain.simulate(wire));
    if (err !== null) throw gatewayError('simulation_failed', 'chain', 409, simulationDetail(err));
    const sent = await deps.chain.send(wire).catch(() => undefined);
    // Spent once the transaction left (a lost reply may still have landed): a failed
    // simulation costs nothing and must not use up the wallet's one sponsorship.
    if (fundsAta) sponsorship.spend(shape.borrower);
    // Lost reply: the transaction may be in flight under the signature we can derive.
    const signature = sent ?? getSignatureFromTransaction(signed);
    const deadline = sent === undefined ? SEND_ERROR_GRACE_MS : CONFIRM_TIMEOUT_MS;
    await chainStep(() => confirm(deps.chain, signature, now, sleep, deadline));
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
