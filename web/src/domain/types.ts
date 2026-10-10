// Plain value types shared by every layer. No runtime code beyond constants.
import type { Address, Blockhash } from '@solana/kit';
import type { EnclaveEntry } from '@tio/oracle-client';
import type { StoredAttestation } from '@tio/oracle-client/attest';
import type { Loan, Pool } from '@tio/demo-pool-client';

/** Gateway error codes of FORMATS §16 that carry nothing beyond a message. */
export type GatewayCode =
  | 'bad_request'
  | 'not_found'
  | 'session_not_found'
  | 'session_expired'
  | 'body_too_large'
  | 'rate_limited'
  | 'relay_in_flight'
  | 'sponsorship_exhausted'
  | 'internal_error'
  | 'too_many_sessions'
  | 'upstream_unavailable'
  | 'enclave_rotated'
  | 'stale_attestation'
  | 'tx_failed'
  | 'enclave_not_registered'
  | 'enclave_revoked'
  | 'attester_mismatch';

/** Failures that happen in the browser rather than at the gateway. */
export type ClientCode =
  | 'protocol_error'
  | 'cancelled'
  | 'network'
  | 'rpc_busy'
  | 'timeout'
  | 'signing_failed'
  | 'loan_exists'
  | 'no_open_loan';

export type AmountProblem =
  | 'empty'
  | 'zero'
  | 'negative'
  | 'too_many_decimals'
  | 'not_a_number'
  | 'over_limit';

/** Every expected failure, as data. Components get these, never thrown errors. */
export type AppError =
  | { code: GatewayCode | ClientCode; message?: string; stage?: string }
  | { code: 'bad_transaction'; rule: number; message?: string }
  | {
      code: 'simulation_failed';
      index?: number;
      custom?: number;
      kind?: string;
      message?: string;
    }
  | { code: 'invalid_amount'; reason: AmountProblem }
  | { code: 'upstream_error'; upstreamCode: string; stage: string; message?: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

/** `GET /v1/info`, camelCased. */
export type Info = {
  cluster: string;
  oracleProgram: Address;
  credential: Address;
  schema: Address;
  measurementId: number;
  policyHash: string;
  attesterAddress: string;
  relayer: Address;
};

export type PersonaId = 'salaried_steady' | 'trader_lumpy' | 'declining' | 'stressed';

export type Session = { sessionId: string; intent: string; intentExpires: bigint };

export type Stage = 'bind' | 'fi_request' | 'fi_fetch' | 'evaluate' | 'submit';

export type Tier = 'A' | 'B' | 'C';

export type AttestResult =
  | { tier: Tier; tx: string | null; attestation: Address; expiry: bigint; payloadHex: string }
  | { tier: 'REJECT' };

/** One event of the `complete` stream (FORMATS §16), already validated. */
export type FlowEvent =
  | { kind: 'stage'; stage: Stage }
  | { kind: 'result'; result: AttestResult }
  | { kind: 'error'; error: AppError };

export type SignatureStatus = {
  confirmationStatus: 'processed' | 'confirmed' | 'finalized';
  err: unknown;
};

export type LatestBlockhash = { blockhash: Blockhash; lastValidBlockHeight: bigint };

/** An account read from chain, decoded by owner and discriminator. */
export type ChainAccount =
  | { kind: 'attestation'; attestation: StoredAttestation }
  | { kind: 'enclave_entry'; entry: EnclaveEntry }
  | { kind: 'pool'; pool: Pool }
  | { kind: 'loan'; loan: Loan };
