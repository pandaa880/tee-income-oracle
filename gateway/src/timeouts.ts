/**
 * Time budgets for outbound chain calls (CODING-GUIDELINES §3: every outbound
 * call has a timeout). Kit's HTTP transport and signature subscription never
 * time out on their own, so a stalled RPC would hang the borrower's stream.
 */

/** One RPC request. */
export const RPC_TIMEOUT_MS = 15_000;
/** Send + confirm one transaction: longer than a blockhash lifetime (~60–90 s). */
export const CONFIRM_TIMEOUT_MS = 100_000;

export const rpcSignal = (): AbortSignal => AbortSignal.timeout(RPC_TIMEOUT_MS);
