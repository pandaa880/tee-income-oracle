// What the borrow page shows: the flow state, corrected by what the chain says about the wallet.
// The gateway is untrusted (CODING-GUIDELINES §3), so a tier is shown as a result only once a
// chain read holds that very attestation: a stream result waits in `confirming` until then.
// A valid tier already on chain skips the flow; a dropped stream waits for the chain to catch up.
import { type Address, getBase16Codec } from '@solana/kit';
import { type DecodedPayload, decodePayload } from '@tio/oracle-client/attest';
import { type CredentialRecord, tierFromByte } from './credential.ts';
import { STAGE_ORDER, type FlowState } from './flow.ts';
import { acceptedPools } from './pool.ts';
import type { AppError, PersonaId, Session, Stage, Tier } from './types.ts';

export type ChainRecord = NonNullable<CredentialRecord['record']>;

export type BorrowView =
  | { step: 'wallet' }
  | { step: 'persona' }
  | { step: 'consent'; session: Session; persona: PersonaId; wallet: Address }
  | { step: 'processing'; stages: Stage[] }
  /** Every stage ran and the gateway reported a tier; waiting for the chain read to show it. */
  | { step: 'confirming'; stages: Stage[] }
  | {
      step: 'result';
      source: 'stream' | 'chain';
      tier: Tier;
      attestation: Address;
      tx: string | null;
      /** The chain record of this very attestation. */
      record: ChainRecord;
    }
  | { step: 'rejected' }
  | { step: 'recovering' }
  | { step: 'failed'; error: AppError };

export type BorrowViewInput = {
  flow: FlowState;
  credential: CredentialRecord | undefined;
  /** The wallet's attestation PDA, shown for a result read from chain; null until it is known. */
  attestation: Address | null;
  /**
   * `issued_at` of the tier the borrower chose to replace ("Attest again"): only a newer record
   * may stand in for the flow, so the old tier can't pose as the new result.
   */
  replacedIssuedAt: bigint | null;
};

/** The enclave keeps working after a disconnect, so these failures are worth waiting out. */
const TRANSPORT = new Set<AppError['code']>(['network', 'timeout', 'rpc_busy']);

export function isTransportFailure(error: AppError): boolean {
  return TRANSPORT.has(error.code);
}

/** A connection lost after the signed intent was sent: the attestation may still land. */
export function isRecoverable(flow: FlowState): boolean {
  return flow.step === 'failed' && flow.sent && isTransportFailure(flow.error);
}

const hex = getBase16Codec();

/** The §7 payload a stream result reported, decoded; null outside a result or if malformed. */
function streamPayload(flow: FlowState): DecodedPayload | null {
  if (flow.step !== 'result' && flow.step !== 'loan') return null;
  try {
    return decodePayload(Uint8Array.from(hex.encode(flow.payloadHex)));
  } catch {
    return null;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Every §7 field equal: the chain holds exactly the payload the gateway reported. */
function samePayload(a: DecodedPayload, b: DecodedPayload): boolean {
  return (
    a.tier === b.tier &&
    a.proofType === b.proofType &&
    a.measurementId === b.measurementId &&
    sameBytes(a.policyHash, b.policyHash) &&
    sameBytes(a.consentHash, b.consentHash) &&
    a.issuedAt === b.issuedAt &&
    a.windowFrom === b.windowFrom &&
    a.windowTo === b.windowTo
  );
}

/** Statuses under which a record isn't an oracle tier the page may show (FORMATS §14 order). */
const NOT_SHOWABLE = new Set<CredentialRecord['status']>(['none', 'foreign_signer', 'expired']);

type Confirmation =
  | { kind: 'pending' }
  | { kind: 'mismatch' }
  | { kind: 'confirmed'; record: ChainRecord };

/**
 * Compares a stream result with the chain read. `issued_at` strictly increases per wallet
 * (§13), so an older record means "not landed yet", while a record at or past the reported
 * `issued_at` that differs in any field, or isn't an oracle tier, means the report was false.
 */
function confirmation(flow: FlowState, credential: CredentialRecord | undefined): Confirmation {
  const reported = streamPayload(flow);
  if (reported === null) return { kind: 'mismatch' };
  const record = credential?.record ?? null;
  if (record === null || record.payload.issuedAt < reported.issuedAt) return { kind: 'pending' };
  if (credential === undefined || NOT_SHOWABLE.has(credential.status)) return { kind: 'mismatch' };
  return samePayload(record.payload, reported)
    ? { kind: 'confirmed', record }
    : { kind: 'mismatch' };
}

const isStreamResult = (flow: FlowState): boolean => flow.step === 'result' || flow.step === 'loan';

function fromChain(input: BorrowViewInput): BorrowView | undefined {
  const { credential, attestation, replacedIssuedAt } = input;
  if (attestation === null || credential?.status !== 'valid' || credential.record === null) {
    return undefined;
  }
  const { record } = credential;
  if (replacedIssuedAt !== null && record.payload.issuedAt <= replacedIssuedAt) return undefined;
  const tier = tierFromByte(record.payload.tier);
  if (tier === null) return undefined;
  return { step: 'result', source: 'chain', tier, attestation, tx: null, record };
}

export function borrowView(input: BorrowViewInput): BorrowView {
  const { flow, credential } = input;
  if (flow.step === 'result' || flow.step === 'loan') {
    const check = confirmation(flow, credential);
    if (check.kind === 'pending') return { step: 'confirming', stages: [...STAGE_ORDER] };
    // The gateway reported something the chain contradicts: never show its version.
    if (check.kind === 'mismatch') return { step: 'failed', error: { code: 'protocol_error' } };
    const { record } = check;
    const tier = tierFromByte(record.payload.tier);
    if (tier === null) return { step: 'failed', error: { code: 'protocol_error' } };
    // Everything shown comes from the chain record; the stream contributes only its tx link.
    return {
      step: 'result',
      source: 'stream',
      tier,
      attestation: flow.attestation,
      tx: flow.tx,
      record,
    };
  }
  if (flow.step === 'rejected') return { step: 'rejected' };
  if (flow.step === 'consent') {
    const { session, persona, wallet } = flow;
    return { step: 'consent', session, persona, wallet };
  }
  if (flow.step === 'processing') return { step: 'processing', stages: flow.stages };
  if (flow.step === 'failed' && !isRecoverable(flow)) return { step: 'failed', error: flow.error };
  // wallet, persona, or a recoverable failure: the chain may already hold the tier.
  const chain = fromChain(input);
  if (chain !== undefined) return chain;
  if (flow.step === 'failed') return { step: 'recovering' };
  return { step: flow.step };
}

/** What a fresh credential read should be keyed to: the stream result it must confirm. */
export function confirmationEpoch(flow: FlowState): string | undefined {
  return flow.step === 'result' || flow.step === 'loan' ? flow.payloadHex : undefined;
}

/** The consent window closed in the page: the same card the gateway's `session_expired` gets. */
export function expireConsent(view: BorrowView, secondsLeft: number): BorrowView {
  if (view.step !== 'consent' || secondsLeft > 0) return view;
  return { step: 'failed', error: { code: 'session_expired' } };
}

/**
 * Keep re-reading the credential while the chain may still change what the page shows: a
 * stream result it doesn't show yet, or a dropped stream whose tier hasn't landed.
 */
export function shouldPollCredential(input: BorrowViewInput): boolean {
  const { flow, credential, replacedIssuedAt } = input;
  if (isStreamResult(flow)) return confirmation(flow, credential).kind === 'pending';
  if (!isRecoverable(flow)) return false;
  // A dropped stream: stop once any new tier landed, whatever this pool thinks of it.
  const record = credential?.record ?? null;
  return (
    record === null || (replacedIssuedAt !== null && record.payload.issuedAt <= replacedIssuedAt)
  );
}

/**
 * The pools that accept the shown result, or null while any pool's read still shows another
 * attestation (or none): a partial list would understate where the tier is accepted.
 */
export function acceptingPools(
  view: BorrowView,
  reads: readonly ({ poolId: number; record: CredentialRecord } | undefined)[],
): { poolId: number; limit: bigint }[] | null {
  if (view.step !== 'result') return null;
  const shown = view.record.payload;
  const same = reads.flatMap((read) => {
    const payload = read?.record.record?.payload;
    return read !== undefined && payload !== undefined && samePayload(payload, shown) ? [read] : [];
  });
  return same.length === reads.length ? acceptedPools(same) : null;
}
