// Borrow and repay through the gateway's relayer: build → borrower signs → relay → confirm.
import {
  type Address,
  getBase58Encoder,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  isSignatureBytes,
  verifySignature,
} from '@solana/kit';
import { useMutation } from '@tanstack/react-query';
import { findLoanPda } from '@tio/demo-pool-client';
import { attestationAddress, decodePayload } from '@tio/oracle-client/attest';
import { type Deps, realDeps } from './deps.ts';
import { useCancelScope } from './use-cancel-scope.ts';
import { sleep } from '../adapters/sleep.ts';
import { waitConfirmed } from '../adapters/confirm.ts';
import {
  buildBorrowMessage,
  buildRepayMessage,
  signForRelay,
  type LoanMessage,
} from '../domain/loan-tx.ts';
import type { AppError } from '../domain/types.ts';

const CONFIRM = { intervalMs: 1000, timeoutMs: 60_000 };

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: AppError }): T => {
  if (!result.ok) throw result.error;
  return result.value;
};

/** What every loan transaction needs from the network: the relayer and a fresh blockhash. */
async function common(deps: Deps, pool: Address, signal: AbortSignal) {
  const info = unwrap(await deps.gateway.info(signal));
  const blockhash = unwrap(await deps.chain.latestBlockhash(signal));
  const { mint, credential, schema } = deps.config.deployment;
  return {
    relayer: info.relayer,
    borrower: deps.signer.signer,
    pool,
    deployment: { mint, credential, schema },
    blockhash,
  };
}

/** The enclave build that scored this borrower: the borrow must name its registry entry. */
async function measurementId(deps: Deps, signal: AbortSignal): Promise<number> {
  const { credential, schema } = deps.config.deployment;
  const at = await attestationAddress(credential, schema, deps.signer.address);
  const [account] = unwrap(await deps.chain.accounts([at], signal));
  if (account?.kind !== 'attestation') throw { code: 'protocol_error' } satisfies AppError;
  return decodePayload(account.attestation.payload).measurementId;
}

/** Longer than the gateway's own 100 s relay deadline (FORMATS §16), so its answer arrives. */
const LOAN_TIMEOUT_MS = 120_000;

/** Reads after `confirmed` can hit a node a slot behind (load-balanced RPC): retry a little. */
const READBACK = { tries: 5, intervalMs: 500 };

type Expect = { pool: Address; kind: 'borrow'; amount: bigint } | { pool: Address; kind: 'repay' };

/**
 * The relayer's word isn't proof: the signature it returns could belong to any landed
 * transaction. So the Loan PDA (one per borrower and pool) is read before and after: a borrow
 * needs it absent before and present with this amount after; a repay needs it present before and
 * gone after. Only this borrower's own signed transaction can make that transition.
 */
async function readLoan(deps: Deps, pool: Address, signal: AbortSignal) {
  const [loanAddress] = await findLoanPda({ pool, borrower: deps.signer.address });
  const [account] = unwrap(await deps.chain.accounts([loanAddress], signal));
  return account?.kind === 'loan' ? account.loan : null;
}

function requireBefore(loan: Awaited<ReturnType<typeof readLoan>>, kind: Expect['kind']): void {
  if (kind === 'borrow' && loan !== null) throw { code: 'loan_exists' } satisfies AppError;
  if (kind === 'repay' && loan === null) throw { code: 'no_open_loan' } satisfies AppError;
}

async function loanLanded(deps: Deps, expect: Expect, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    const loan = await readLoan(deps, expect.pool, signal);
    const landed =
      expect.kind === 'repay'
        ? loan === null
        : loan !== null &&
          loan.borrower === deps.signer.address &&
          loan.pool === expect.pool &&
          loan.amount === expect.amount;
    if (landed || attempt >= READBACK.tries || signal.aborted) return landed;
    await sleep(READBACK.intervalMs, signal);
  }
}

/**
 * A transaction's id is its fee payer's signature over the message bytes, and the fee payer here
 * is the relayer. So the signature the gateway returns must verify, under the relayer's key,
 * over the exact message we built and the borrower signed. An unrelated (or replayed) signature
 * can't, and once it verifies, "confirmed" can only mean this transaction landed. Account reads
 * can't establish this: any of them may come from a stale node.
 */
async function isOurTransaction(signature: string, txB64: string, relayer: Address) {
  const wire = Uint8Array.from(getBase64Encoder().encode(txB64));
  const { messageBytes } = getTransactionDecoder().decode(wire);
  const bytes = Uint8Array.from(getBase58Encoder().encode(signature));
  if (!isSignatureBytes(bytes)) return false;
  return verifySignature(await getPublicKeyFromAddress(relayer), bytes, messageBytes);
}

async function relayAndConfirm(
  deps: Deps,
  message: LoanMessage,
  expect: Expect,
  signal: AbortSignal,
): Promise<string> {
  requireBefore(await readLoan(deps, expect.pool, signal), expect.kind);
  const txB64 = await signForRelay(message);
  const signature = unwrap(await deps.relay.relay(txB64, signal));
  if (!(await isOurTransaction(signature, txB64, message.feePayer.address))) {
    throw { code: 'protocol_error' } satisfies AppError;
  }
  const outcome = await waitConfirmed(deps.chain, signature, { ...CONFIRM, signal });
  if (outcome.status !== 'confirmed') {
    throw { code: outcome.status === 'failed' ? 'tx_failed' : outcome.status } satisfies AppError;
  }
  if (!(await loanLanded(deps, expect, signal))) {
    throw { code: 'protocol_error' } satisfies AppError;
  }
  return signature;
}

export function useLoan(pool: Address, deps: Deps = realDeps()) {
  const { next: nextSignal } = useCancelScope(LOAN_TIMEOUT_MS);
  const borrow = useMutation<string, AppError, bigint>({
    mutationFn: async (amount) => {
      const signal = nextSignal();
      const base = await common(deps, pool, signal);
      const message = await buildBorrowMessage({
        ...base,
        measurementId: await measurementId(deps, signal),
        amount,
      });
      return relayAndConfirm(deps, message, { pool, kind: 'borrow', amount }, signal);
    },
  });
  const repay = useMutation<string, AppError>({
    mutationFn: async () => {
      const signal = nextSignal();
      const message = await buildRepayMessage(await common(deps, pool, signal));
      return relayAndConfirm(deps, message, { pool, kind: 'repay' }, signal);
    },
  });
  return { borrow, repay };
}
