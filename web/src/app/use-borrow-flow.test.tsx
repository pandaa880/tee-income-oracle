import { act, renderHook, waitFor } from '@testing-library/react';
import {
  type Address,
  generateKeyPairSigner,
  getBase16Codec,
  getBase58Decoder,
  type SignatureBytes,
} from '@solana/kit';
import { attestationAddress } from '@tio/oracle-client/attest';
import { describe, expect, it, vi } from 'vitest';
import { useBorrowFlow } from './use-borrow-flow.ts';
import { buildIntent } from '../domain/intent.ts';
import type { BorrowerSigner, GatewayPort } from '../domain/ports.ts';
import type { ChainAccount, FlowEvent } from '../domain/types.ts';
import {
  fail,
  fakeChain,
  fakeDeps,
  fakeGateway,
  INTENT_EXPIRES,
  ok,
  SESSION_ID,
} from '../test-support/fakes.ts';
import {
  CREDENTIAL,
  payloadBytes,
  pool,
  POOL_0,
  POOL_1,
  SCHEMA,
} from '../test-support/fixtures.ts';

const SIGNATURE = new Uint8Array(64).fill(7) as SignatureBytes;
const POLICY_HEX = '11'.repeat(32);

/** A tier A result the hook accepts: the wallet's own attestation PDA, tier byte 1. */
async function resultFor(wallet: Address): Promise<FlowEvent> {
  return {
    kind: 'result',
    result: {
      tier: 'A',
      tx: 'sig-1',
      attestation: await attestationAddress(CREDENTIAL, SCHEMA, wallet),
      expiry: 99n,
      payloadHex: getBase16Codec().decode(payloadBytes({ tier: 1 })),
    },
  };
}

async function makeSigner(): Promise<BorrowerSigner> {
  const signer = await generateKeyPairSigner();
  return {
    address: signer.address,
    signIntent: vi.fn<BorrowerSigner['signIntent']>(async () => SIGNATURE),
    signer,
  };
}

const script = (events: readonly FlowEvent[]): GatewayPort['completeSession'] =>
  async function* () {
    for (const event of events) {
      await Promise.resolve();
      yield event;
    }
  };

/** Both deployment pools on chain, under the policy the fake gateway's intents name. */
const poolsOnChain = () =>
  new Map<Address, ChainAccount>([
    [POOL_0, { kind: 'pool', pool: pool() }],
    [POOL_1, { kind: 'pool', pool: pool() }],
  ]);

type Events = readonly FlowEvent[] | ((wallet: Address) => Promise<readonly FlowEvent[]>);

async function setup(events: Events, gateway: Partial<GatewayPort> = {}) {
  const signer = await makeSigner();
  const list = typeof events === 'function' ? await events(signer.address) : events;
  const completeSession = vi.fn<GatewayPort['completeSession']>(script(list));
  const deps = fakeDeps(signer, fakeChain(poolsOnChain()), {
    gateway: fakeGateway({ completeSession, ...gateway }),
  });
  const hook = renderHook(() => useBorrowFlow(deps));
  return { ...hook, signer, deps, completeSession };
}

async function toConsent(result: { current: ReturnType<typeof useBorrowFlow> }) {
  act(() => result.current.connect());
  await act(() => result.current.choosePersona('salaried_steady'));
}

describe('useBorrowFlow', () => {
  it('starts at the wallet step', async () => {
    const { result } = await setup([]);
    expect(result.current.state.step).toBe('wallet');
  });

  it('connect takes the wallet address from the signer', async () => {
    const { result, signer } = await setup([]);
    act(() => result.current.connect());
    expect(result.current.state).toMatchObject({ step: 'persona', wallet: signer.address });
  });

  it('choosePersona creates a session with the wallet and persona and moves to consent', async () => {
    const { result, signer, deps } = await setup([]);
    act(() => result.current.connect());
    await act(() => result.current.choosePersona('trader_lumpy'));
    expect(deps.gateway.createSession).toHaveBeenCalledWith(
      signer.address,
      'trader_lumpy',
      expect.any(AbortSignal),
    );
    expect(result.current.state).toMatchObject({
      step: 'consent',
      persona: 'trader_lumpy',
      session: { sessionId: SESSION_ID },
    });
  });

  it('a failed session creation ends in failed with the typed error', async () => {
    const { result } = await setup([], {
      createSession: vi.fn<GatewayPort['createSession']>(async () =>
        fail({ code: 'rate_limited' }),
      ),
    });
    act(() => result.current.connect());
    await act(() => result.current.choosePersona('declining'));
    expect(result.current.state).toMatchObject({ step: 'failed', error: { code: 'rate_limited' } });
  });

  it('confirmConsent signs the exact §9 intent bytes, completes with base58, ends in result', async () => {
    const { result, signer, completeSession } = await setup(async (wallet) => [
      { kind: 'stage', stage: 'bind' },
      { kind: 'stage', stage: 'submit' },
      await resultFor(wallet),
    ]);
    await toConsent(result);
    await act(() => result.current.confirmConsent());
    const intent = buildIntent({
      sessionId: SESSION_ID,
      wallet: signer.address,
      policyHashHex: POLICY_HEX,
      expires: INTENT_EXPIRES,
    });
    expect(signer.signIntent).toHaveBeenCalledWith(
      new TextEncoder().encode(intent),
      expect.any(AbortSignal),
    );
    expect(completeSession).toHaveBeenCalledWith(
      SESSION_ID,
      getBase58Decoder().decode(SIGNATURE),
      expect.any(AbortSignal),
    );
    expect(result.current.state).toMatchObject({ step: 'result', tier: 'A', tx: 'sig-1' });
  });

  it('shows the stages as they arrive while processing', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let final: FlowEvent | undefined;
    const { result } = await setup([], {
      completeSession: async function* () {
        yield { kind: 'stage', stage: 'bind' } satisfies FlowEvent;
        await gate;
        if (final !== undefined) yield final;
      },
    });
    act(() => result.current.connect());
    final = await resultFor(
      result.current.state.step === 'persona' ? result.current.state.wallet : POOL_0,
    );
    await act(() => result.current.choosePersona('salaried_steady'));
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.confirmConsent();
    });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ step: 'processing', stages: ['bind'] }),
    );
    release();
    await act(() => done);
    expect(result.current.state.step).toBe('result');
  });

  it('a REJECT result ends in rejected', async () => {
    const { result } = await setup([{ kind: 'result', result: { tier: 'REJECT' } }]);
    await toConsent(result);
    await act(() => result.current.confirmConsent());
    expect(result.current.state.step).toBe('rejected');
  });

  it('an error event ends in failed', async () => {
    const { result } = await setup([
      { kind: 'stage', stage: 'bind' },
      { kind: 'error', error: { code: 'enclave_revoked' } },
    ]);
    await toConsent(result);
    await act(() => result.current.confirmConsent());
    expect(result.current.state).toMatchObject({
      step: 'failed',
      error: { code: 'enclave_revoked' },
    });
  });

  it('reset returns to the wallet step', async () => {
    const { result } = await setup([]);
    act(() => result.current.connect());
    act(() => result.current.reset());
    expect(result.current.state.step).toBe('wallet');
  });
});

const tampered = (intentFor: (wallet: Address) => string) =>
  vi.fn<GatewayPort['createSession']>(async (wallet) =>
    ok({ sessionId: SESSION_ID, intent: intentFor(wallet), intentExpires: INTENT_EXPIRES }),
  );
const intent = (wallet: Address, overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) =>
  buildIntent({
    sessionId: SESSION_ID,
    wallet,
    policyHashHex: POLICY_HEX,
    expires: INTENT_EXPIRES,
    ...overrides,
  });

describe('useBorrowFlow treats the gateway as untrusted', () => {
  it.each([
    ['names another wallet', (w: Address) => intent(w, { wallet: POOL_0 })],
    ['names another session', (w: Address) => intent(w, { sessionId: 'other' })],
    ['names another expiry', (w: Address) => intent(w, { expires: INTENT_EXPIRES + 1n })],
    ['names a policy no pool uses', (w: Address) => intent(w, { policyHashHex: '99'.repeat(32) })],
    ['has a trailing newline', (w: Address) => `${intent(w)}\n`],
    ['is not the §9 text at all', () => 'please sign anything'],
  ])('refuses to sign an intent that %s', async (_, intentFor) => {
    const { result, signer, completeSession } = await setup([], {
      createSession: tampered(intentFor),
    });
    await toConsent(result);
    await act(() => result.current.confirmConsent());
    expect(signer.signIntent).not.toHaveBeenCalled();
    expect(completeSession).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      step: 'failed',
      error: { code: 'protocol_error' },
    });
  });

  it('rejects a result naming an attestation that is not the wallet PDA', async () => {
    const { result } = await setup(async (wallet) => {
      const event = await resultFor(wallet);
      return event.kind === 'result' && event.result.tier !== 'REJECT'
        ? [{ ...event, result: { ...event.result, attestation: POOL_1 } }]
        : [];
    });
    await toConsent(result);
    await act(() => result.current.confirmConsent());
    expect(result.current.state).toMatchObject({
      step: 'failed',
      error: { code: 'protocol_error' },
    });
  });

  it('rejects a result whose claimed tier differs from the payload tier byte', async () => {
    const { result } = await setup(async (wallet) => {
      const event = await resultFor(wallet);
      return event.kind === 'result' && event.result.tier !== 'REJECT'
        ? [{ ...event, result: { ...event.result, tier: 'B' as const } }]
        : [];
    });
    await toConsent(result);
    await act(() => result.current.confirmConsent());
    expect(result.current.state).toMatchObject({
      step: 'failed',
      error: { code: 'protocol_error' },
    });
  });

  it('ends in signing_failed, not cancelled, when the wallet throws', async () => {
    const { result, signer, completeSession } = await setup([]);
    vi.mocked(signer.signIntent).mockRejectedValue(new Error('wallet broke'));
    await toConsent(result);
    await act(() => result.current.confirmConsent());
    expect(completeSession).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      step: 'failed',
      error: { code: 'signing_failed' },
    });
  });

  it('aborts the in-flight session stream on unmount', async () => {
    let seen: AbortSignal | undefined;
    const { promise: never } = Promise.withResolvers<void>();
    const { result, unmount } = await setup([], {
      completeSession: async function* (_id, _sig, signal) {
        seen = signal;
        await never;
        yield { kind: 'stage', stage: 'bind' } satisfies FlowEvent;
      },
    });
    await toConsent(result);
    act(() => {
      void result.current.confirmConsent();
    });
    await waitFor(() => expect(seen).toBeDefined());
    unmount();
    expect(seen?.aborted).toBe(true);
  });

  it('refuses an intent that expires further out than the enclave ever sets (now + 600 s)', async () => {
    const far = INTENT_EXPIRES + 3600n;
    const { result, signer } = await setup([], {
      createSession: vi.fn<GatewayPort['createSession']>(async (wallet) =>
        ok({ sessionId: SESSION_ID, intent: intent(wallet, { expires: far }), intentExpires: far }),
      ),
    });
    await toConsent(result);
    await act(() => result.current.confirmConsent());
    expect(signer.signIntent).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      step: 'failed',
      error: { code: 'protocol_error' },
    });
  });

  it('surfaces a failed pool read and signs nothing', async () => {
    const { result, signer, deps } = await setup([]);
    vi.mocked(deps.chain.accounts).mockResolvedValue(fail({ code: 'rpc_busy' }));
    await toConsent(result);
    await act(() => result.current.confirmConsent());
    expect(signer.signIntent).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ step: 'failed', error: { code: 'rpc_busy' } });
  });

  it('accepts a policy used by only one of the listed pools', async () => {
    const policyB = new Uint8Array(32).fill(0x33);
    const { result, signer, deps } = await setup(async (wallet) => [await resultFor(wallet)], {
      createSession: tampered((w) => intent(w, { policyHashHex: '33'.repeat(32) })),
    });
    const store = new Map<Address, ChainAccount>([
      [POOL_0, { kind: 'pool', pool: pool() }],
      [POOL_1, { kind: 'pool', pool: pool({ policyHash: policyB }) }],
    ]);
    vi.mocked(deps.chain.accounts).mockImplementation(async (addresses) =>
      ok(addresses.map((a) => store.get(a) ?? null)),
    );
    await toConsent(result);
    await act(() => result.current.confirmConsent());
    expect(signer.signIntent).toHaveBeenCalledOnce();
  });

  it('signs and completes once when confirmConsent is called twice before a render', async () => {
    const { result, signer, completeSession } = await setup(async (wallet) => [
      await resultFor(wallet),
    ]);
    await toConsent(result);
    await act(async () => {
      const first = result.current.confirmConsent();
      const second = result.current.confirmConsent();
      await Promise.all([first, second]);
    });
    expect(signer.signIntent).toHaveBeenCalledOnce();
    expect(completeSession).toHaveBeenCalledOnce();
  });

  it('ignores a request from before reset() that settles after reconnecting', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { result } = await setup([], {
      createSession: vi.fn<GatewayPort['createSession']>(async () => {
        await gate;
        return fail({ code: 'cancelled' });
      }),
    });
    act(() => result.current.connect());
    let stale: Promise<void> = Promise.resolve();
    act(() => {
      stale = result.current.choosePersona('declining');
    });
    act(() => result.current.reset());
    act(() => result.current.connect());
    release();
    await act(() => stale);
    expect(result.current.state.step).toBe('persona');
  });
});
