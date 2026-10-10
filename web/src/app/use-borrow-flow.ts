// The attest half of the borrow flow: wallet → persona → consent → live processing → result.
// The gateway is untrusted: what it asks us to sign and what it reports back are both checked.
import { type Address, getBase16Codec, getBase58Decoder } from '@solana/kit';
import { decodePayload, attestationAddress } from '@tio/oracle-client/attest';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { type Deps, realDeps } from './deps.ts';
import { useCancelScope } from './use-cancel-scope.ts';
import { type FlowState, flowReducer, initialFlowState } from '../domain/flow.ts';
import { checkIntent, intentPolicy } from '../domain/intent.ts';
import type { AppError, FlowEvent, PersonaId, Result } from '../domain/types.ts';

export type BorrowFlow = {
  state: FlowState;
  connect(): void;
  choosePersona(persona: PersonaId): Promise<void>;
  confirmConsent(): Promise<void>;
  reset(): void;
};

const hex = getBase16Codec();
const TIER_BYTE = { A: 1, B: 2, C: 3 } as const;
const failure = (error: AppError): FlowEvent => ({ kind: 'error', error });

/** Longer than any session: the intent itself expires after 600 s (FORMATS §10). */
const SESSION_TIMEOUT_MS = 660_000;

/** The policy hashes (hex) of the deployment's pools, read from chain. */
async function poolPolicies(deps: Deps, signal: AbortSignal): Promise<Result<string[]>> {
  const addresses = deps.config.deployment.pools.map((p) => p.address);
  const read = await deps.chain.accounts(addresses, signal);
  if (!read.ok) return read;
  const policies = read.value.flatMap((a) =>
    a?.kind === 'pool' ? [hex.decode(Uint8Array.from(a.pool.params.policyHash))] : [],
  );
  return { ok: true, value: policies };
}

/**
 * A result names the wallet's own attestation PDA and a payload whose tier byte is the tier it
 * claims, scored under the policy the borrower signed; otherwise the gateway's report is not
 * believed. (The chain read on the result page is
 * what shows it as verified.)
 */
async function checkedEvent(
  event: FlowEvent,
  deps: Deps,
  wallet: Address,
  signedPolicy: string | undefined,
): Promise<FlowEvent> {
  if (event.kind !== 'result' || event.result.tier === 'REJECT') return event;
  const { credential, schema } = deps.config.deployment;
  const { tier, attestation, payloadHex } = event.result;
  const expected = await attestationAddress(credential, schema, wallet);
  const payload = decodePayload(Uint8Array.from(hex.encode(payloadHex)));
  const ok =
    attestation === expected &&
    payload.tier === TIER_BYTE[tier] &&
    hex.decode(payload.policyHash) === signedPolicy;
  return ok ? event : failure({ code: 'protocol_error' });
}

export function useBorrowFlow(deps: Deps = realDeps()): BorrowFlow {
  const [state, dispatch] = useReducer(flowReducer, initialFlowState);
  // The latest state for the async callbacks, without re-creating them on every event.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const { next: nextSignal, cancel } = useCancelScope(SESSION_TIMEOUT_MS);
  // One request at a time: a double click before the next render can't sign or complete twice.
  const busy = useRef(false);
  // Bumped by reset(): a request from an earlier flow may still settle (e.g. as `cancelled`), and
  // must neither dispatch into the new flow nor clear its busy guard.
  const generation = useRef(0);

  const connect = useCallback(() => {
    dispatch({ type: 'connect', wallet: deps.signer.address });
  }, [deps]);

  const choosePersona = useCallback(
    async (persona: PersonaId) => {
      const current = stateRef.current;
      if (current.step !== 'persona' || busy.current) return;
      busy.current = true;
      const mine = generation.current;
      try {
        // Creating a session is one short request: it gets its own 30 s bound.
        const signal = AbortSignal.any([nextSignal(), AbortSignal.timeout(30_000)]);
        const result = await deps.gateway.createSession(current.wallet, persona, signal);
        if (mine !== generation.current) return;
        dispatch(
          result.ok
            ? { type: 'session_created', persona, session: result.value }
            : { type: 'failed', error: result.error },
        );
      } finally {
        if (mine === generation.current) busy.current = false;
      }
    },
    [deps, nextSignal],
  );

  const signIntent = useCallback(
    async (bytes: Uint8Array, signal: AbortSignal): Promise<Result<string>> => {
      try {
        const signature = await deps.signer.signIntent(bytes, signal);
        return { ok: true, value: getBase58Decoder().decode(signature) };
      } catch {
        return { ok: false, error: { code: signal.aborted ? 'cancelled' : 'signing_failed' } };
      }
    },
    [deps],
  );

  const confirmConsent = useCallback(async () => {
    const current = stateRef.current;
    if (current.step !== 'consent' || busy.current) return;
    busy.current = true;
    const mine = generation.current;
    const live = () => mine === generation.current;
    const signal = nextSignal();
    const { session, wallet } = current;
    dispatch({ type: 'consent_given' });
    try {
      const policies = await poolPolicies(deps, signal);
      const bytes = policies.ok
        ? checkIntent(session, wallet, policies.value, BigInt(Math.floor(Date.now() / 1000)))
        : policies;
      const signed = bytes.ok ? await signIntent(bytes.value, signal) : bytes;
      if (!signed.ok) {
        if (live()) dispatch({ type: 'event', event: failure(signed.error) });
        return;
      }
      const events = deps.gateway.completeSession(session.sessionId, signed.value, signal);
      for await (const event of events) {
        const checked = await checkedEvent(event, deps, wallet, intentPolicy(session.intent));
        if (!live()) return;
        dispatch({ type: 'event', event: checked });
      }
    } finally {
      if (live()) busy.current = false;
    }
  }, [deps, nextSignal, signIntent]);

  // Abort whatever is in flight, so a late stream can't hold the busy guard after a reset.
  const reset = useCallback(() => {
    generation.current += 1;
    cancel();
    busy.current = false;
    dispatch({ type: 'reset' });
  }, [cancel]);

  return { state, connect, choosePersona, confirmConsent, reset };
}
