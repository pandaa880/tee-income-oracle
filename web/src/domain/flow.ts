// The borrow flow as a reducer over a discriminated union. Impossible transitions return the
// same state object, so React skips the render and a late event can't rewind the flow.
import type { Address } from '@solana/kit';
import type { AppError, FlowEvent, PersonaId, Session, Stage, Tier } from './types.ts';

export type FlowState =
  | { step: 'wallet' }
  | { step: 'persona'; wallet: Address }
  | { step: 'consent'; wallet: Address; persona: PersonaId; session: Session }
  | { step: 'processing'; wallet: Address; persona: PersonaId; session: Session; stages: Stage[] }
  | { step: 'result'; wallet: Address; tier: Tier; attestation: Address; tx: string | null }
  | { step: 'rejected'; wallet: Address }
  | { step: 'failed'; wallet: Address; error: AppError }
  | {
      step: 'loan';
      wallet: Address;
      tier: Tier;
      attestation: Address;
      tx: string | null;
      loan: 'open' | 'repaid';
    };

export type FlowAction =
  | { type: 'connect'; wallet: Address }
  | { type: 'session_created'; persona: PersonaId; session: Session }
  | { type: 'consent_given' }
  | { type: 'event'; event: FlowEvent }
  | { type: 'failed'; error: AppError }
  | { type: 'loan_opened' }
  | { type: 'loan_repaid' }
  | { type: 'reset' };

export const initialFlowState: FlowState = { step: 'wallet' };

/** FORMATS §16: stages arrive once each, in this order; REJECT has no `submit` stage. */
export const STAGE_ORDER: readonly Stage[] = [
  'bind',
  'fi_request',
  'fi_fetch',
  'evaluate',
  'submit',
];

const outOfOrder = (wallet: Address): FlowState => ({
  step: 'failed',
  wallet,
  error: { code: 'protocol_error' },
});

function onEvent(state: FlowState, event: FlowEvent): FlowState {
  if (state.step !== 'processing') return state;
  if (event.kind === 'error') return { step: 'failed', wallet: state.wallet, error: event.error };
  const done = state.stages.length;
  if (event.kind === 'stage') {
    // Only the next stage is accepted: a duplicate, skipped or late stage is a broken stream.
    if (event.stage !== STAGE_ORDER[done]) return outOfOrder(state.wallet);
    return { ...state, stages: [...state.stages, event.stage] };
  }
  const { result } = event;
  // A tier is written in `submit`; a REJECT is decided in `evaluate` and never submits.
  const expectedLast = result.tier === 'REJECT' ? 'evaluate' : 'submit';
  if (state.stages.at(-1) !== expectedLast) return outOfOrder(state.wallet);
  if (result.tier === 'REJECT') return { step: 'rejected', wallet: state.wallet };
  const { tier, attestation, tx } = result;
  return { step: 'result', wallet: state.wallet, tier, attestation, tx };
}

function onConnect(state: FlowState, wallet: Address): FlowState {
  if (state.step !== 'wallet' && state.wallet === wallet) return state;
  return { step: 'persona', wallet };
}

function onLoan(state: FlowState, action: 'loan_opened' | 'loan_repaid'): FlowState {
  if (action === 'loan_opened' && state.step === 'result') {
    return { ...state, step: 'loan', loan: 'open' };
  }
  if (action === 'loan_repaid' && state.step === 'loan' && state.loan === 'open') {
    return { ...state, loan: 'repaid' };
  }
  return state;
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  if (action.type === 'connect') return onConnect(state, action.wallet);
  if (action.type === 'session_created') {
    if (state.step !== 'persona') return state;
    const { persona, session } = action;
    return { step: 'consent', wallet: state.wallet, persona, session };
  }
  if (action.type === 'consent_given') {
    return state.step === 'consent' ? { ...state, step: 'processing', stages: [] } : state;
  }
  if (action.type === 'event') return onEvent(state, action.event);
  if (action.type === 'failed') {
    const live =
      state.step === 'persona' || state.step === 'consent' || state.step === 'processing';
    return live ? { step: 'failed', wallet: state.wallet, error: action.error } : state;
  }
  if (action.type === 'loan_opened' || action.type === 'loan_repaid') {
    return onLoan(state, action.type);
  }
  // Only 'reset' is left; a new action type fails to compile here until it is handled.
  const reset: 'reset' = action.type;
  void reset;
  return initialFlowState;
}
