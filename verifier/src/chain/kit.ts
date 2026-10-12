/** `ChainReader` over a `@solana/kit` RPC (`getAccountInfo`, base64). */
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { b64Decode } from '@tio/encoding';
import { VerifierError } from '../errors.ts';
import type { ChainReader } from './ports.ts';

export type AccountRpc = Rpc<Pick<SolanaRpcApi, 'getAccountInfo'>>;

const DEFAULT_TIMEOUT_MS = 15_000;

/** The RPC's response; any transport failure is `fetch_failed` (the RPC's own message is not repeated). */
async function accountInfo(rpc: AccountRpc, address: Address, timeoutMs: number) {
  try {
    return await rpc
      .getAccountInfo(address, { encoding: 'base64' })
      .send({ abortSignal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new VerifierError('fetch_failed', `getAccountInfo ${address} failed`);
  }
}

/** A hung RPC becomes an error after `timeoutMs`, never a hung verification. */
export function kitChainReader(rpc: AccountRpc, timeoutMs = DEFAULT_TIMEOUT_MS): ChainReader {
  return {
    async account(address: Address) {
      const { value } = await accountInfo(rpc, address, timeoutMs);
      if (value === null) return null;
      return { owner: value.owner, data: b64Decode(value.data[0]) };
    },
  };
}
