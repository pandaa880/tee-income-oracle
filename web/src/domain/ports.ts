// The ports the app layer talks to. Adapters implement them; tests pass fakes.
import type { Address, SignatureBytes, TransactionSigner } from '@solana/kit';
import type { Loan } from '@tio/demo-pool-client';
import type {
  ChainAccount,
  FlowEvent,
  Info,
  LatestBlockhash,
  PersonaId,
  Result,
  Session,
  SignatureStatus,
} from './types.ts';

/** One open Loan as `getProgramAccounts` returns it: its account address and decoded body. */
export type PoolLoan = { address: Address; loan: Loan };

export type GatewayPort = {
  createSession: (
    wallet: Address,
    persona: PersonaId,
    signal: AbortSignal,
  ) => Promise<Result<Session>>;
  /** Never throws: every failure arrives as a final `{ kind: 'error' }` event. */
  completeSession: (
    sessionId: string,
    signatureB58: string,
    signal: AbortSignal,
  ) => AsyncIterable<FlowEvent>;
  info: (signal: AbortSignal) => Promise<Result<Info>>;
  health: (signal: AbortSignal) => Promise<Result<true>>;
};

export type RelayPort = {
  /** The relayed transaction's base58 signature, already `confirmed` by the gateway's poll. */
  relay: (txB64: string, signal: AbortSignal) => Promise<Result<string>>;
};

export type ChainPort = {
  /** In request order; `null` for an account that doesn't exist. */
  accounts: (addresses: Address[], signal: AbortSignal) => Promise<Result<(ChainAccount | null)[]>>;
  /** Every open Loan of one pool, each checked to be a demo-pool Loan of that pool. */
  poolLoans: (pool: Address, signal: AbortSignal) => Promise<Result<readonly PoolLoan[]>>;
  latestBlockhash: (signal: AbortSignal) => Promise<Result<LatestBlockhash>>;
  /** `null` while the cluster doesn't know the signature yet. */
  signatureStatus: (
    signature: string,
    signal: AbortSignal,
  ) => Promise<Result<SignatureStatus | null>>;
};

export type StoragePort = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
};

/** One borrower key, whichever wallet holds it. */
export type BorrowerSigner = {
  address: Address;
  /** Signs the exact §9 intent bytes. */
  signIntent: (bytes: Uint8Array, signal: AbortSignal) => Promise<SignatureBytes>;
  signer: TransactionSigner;
};
