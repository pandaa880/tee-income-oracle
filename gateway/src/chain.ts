/**
 * The chain operations the relayer needs, as two small ports (`Chain` for the
 * attestation relayer, `RelayChain` for the loan relay), plus the kit adapter
 * that implements both over RPC with timeouts (CODING-GUIDELINES §3: kit's HTTP
 * transport and signature subscription never time out on their own). Tests fake
 * the ports to drive every branch.
 */
import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  sendAndConfirmTransactionFactory,
} from '@solana/kit';

import { b64Decode } from '@tio/encoding';
import { CONFIRM_TIMEOUT_MS, rpcSignal } from './timeouts.ts';

export type SignedTransaction = Parameters<ReturnType<typeof sendAndConfirmTransactionFactory>>[0];
export type SignatureStatus = { err: unknown; confirmationStatus: string | null };
export type RawAccount = { owner: Address; data: Uint8Array };

export type Chain = {
  latestBlockhash: () => Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>;
  /** Sends and waits for `confirmed`; rejects with the cluster's error. */
  sendAndConfirm: (tx: SignedTransaction) => Promise<void>;
  signatureStatuses: (sigs: readonly Signature[]) => Promise<readonly (SignatureStatus | null)[]>;
  account: (at: Address) => Promise<RawAccount | null>;
};

/**
 * What the loan relay needs for a fully signed wire transaction it did not
 * build: a simulation that checks every signature, a plain send, and status
 * polls (its blockhash lifetime is the browser's, so kit's send-and-confirm
 * can't be reused).
 */
export type RelayChain = {
  /** `err` is null when the transaction would succeed. */
  simulate: (wire: Base64EncodedWireTransaction) => Promise<{ err: unknown }>;
  send: (wire: Base64EncodedWireTransaction) => Promise<Signature>;
  signatureStatuses: Chain['signatureStatuses'];
  /** Whether the borrower's token account exists (null = the relayer would pay its rent). */
  account: Chain['account'];
  /** Whether any transaction ever touched `address` (a closed account keeps its history). */
  hasHistory: (address: Address) => Promise<boolean>;
};

export function kitChain(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
): Chain & RelayChain {
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  return {
    latestBlockhash: async () =>
      (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send({ abortSignal: rpcSignal() }))
        .value,
    sendAndConfirm: (tx) =>
      sendAndConfirm(tx, {
        commitment: 'confirmed',
        abortSignal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS),
      }),
    signatureStatuses: async (sigs) =>
      (await rpc.getSignatureStatuses(sigs).send({ abortSignal: rpcSignal() })).value,
    account: async (at) => {
      const { value } = await rpc
        .getAccountInfo(at, { encoding: 'base64', commitment: 'confirmed' })
        .send({ abortSignal: rpcSignal() });
      if (value === null) return null;
      return { owner: value.owner, data: b64Decode(value.data[0]) };
    },
    simulate: async (wire) => {
      const { value } = await rpc
        .simulateTransaction(wire, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' })
        .send({ abortSignal: rpcSignal() });
      return { err: value.err };
    },
    send: (wire) =>
      rpc
        .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
        .send({ abortSignal: rpcSignal() }),
    hasHistory: async (at) =>
      (
        await rpc
          .getSignaturesForAddress(at, { limit: 1, commitment: 'confirmed' })
          .send({ abortSignal: rpcSignal() })
      ).length > 0,
  };
}
