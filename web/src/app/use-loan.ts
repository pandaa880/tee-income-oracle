// Borrow and repay through the gateway's relayer: build → borrower signs → relay → confirm.
import type { Address } from '@solana/kit';
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
 * transaction. After it confirms, read the Loan PDA: after a borrow it must hold this borrower's
 * loan of exactly this amount (an older open loan doesn't count); after a repay it must be gone.
 */
async function loanLanded(deps: Deps, expect: Expect, signal: AbortSignal): Promise<boolean> {
  const borrower = deps.signer.address;
  const [loanAddress] = await findLoanPda({ pool: expect.pool, borrower });
  for (let attempt = 1; ; attempt++) {
    const [account] = unwrap(await deps.chain.accounts([loanAddress], signal));
    const landed =
      expect.kind === 'repay'
        ? account === null
        : account?.kind === 'loan' &&
          account.loan.borrower === borrower &&
          account.loan.pool === expect.pool &&
          account.loan.amount === expect.amount;
    if (landed || attempt >= READBACK.tries || signal.aborted) return landed;
    await sleep(READBACK.intervalMs, signal);
  }
}

async function relayAndConfirm(
  deps: Deps,
  message: LoanMessage,
  expect: Expect,
  signal: AbortSignal,
): Promise<string> {
  const signature = unwrap(await deps.relay.relay(await signForRelay(message), signal));
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
