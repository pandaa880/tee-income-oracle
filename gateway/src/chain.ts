/**
 * The four chain operations the relayer needs, as a small port, plus the kit
 * adapter that implements them over RPC with timeouts (CODING-GUIDELINES §3:
 * kit's HTTP transport and signature subscription never time out on their
 * own). Tests fake the port to drive every relayer branch.
 */
import {
  type Address,
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

export function kitChain(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
): Chain {
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
  };
}
