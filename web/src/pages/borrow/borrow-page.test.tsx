import { fireEvent, screen } from '@testing-library/react';
import { type Address, getBase16Codec } from '@solana/kit';
import { attestationAddress, parseSasAttestation, SAS_PROGRAM_ID } from '@tio/oracle-client/attest';
import { describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../app/deps.ts';
import { STAGE_ORDER } from '../../domain/flow.ts';
import { STAGE_COPY } from '../../domain/stages.ts';
import type { GatewayPort } from '../../domain/ports.ts';
import type { FlowEvent } from '../../domain/types.ts';
import { SIG } from '../../test-support/fakes.ts';
import { CREDENTIAL, payloadBytes, SCHEMA, sasAccountBytes } from '../../test-support/fixtures.ts';
import { renderApp } from '../../test-support/render.tsx';
import { liveAttestation, world, type WorldOptions } from '../../test-support/world.ts';
import { buildIntent } from '../../domain/intent.ts';
import { fail, ok } from '../../test-support/fakes.ts';

const hoisted = vi.hoisted(() => ({ deps: undefined as Deps | undefined }));
vi.mock('../../app/deps.ts', () => ({
  realDeps: () => {
    if (hoisted.deps === undefined) throw new Error('test deps not set');
    return hoisted.deps;
  },
}));

const STAGES: FlowEvent[] = STAGE_ORDER.map((stage) => ({ kind: 'stage', stage }));

/** A world with no tier yet whose gateway plays `script` when the borrower approves. */
async function scripted(
  script: (ctx: {
    wallet: Address;
    write: () => Promise<void>;
    result: () => Promise<FlowEvent>;
  }) => AsyncGenerator<FlowEvent>,
  options: WorldOptions = {},
) {
  const w = await world({ attestation: false, ...options });
  const live = liveAttestation({ tier: 1 });
  const payload = payloadBytes(live.payload);
  // What the enclave does before it reports the result: write the attestation to chain.
  const write = async () => {
    const bytes = sasAccountBytes({ wallet: w.wallet, payload, expiry: live.expiry });
    w.store.set(await attestationAddress(CREDENTIAL, SCHEMA, w.wallet), {
      kind: 'attestation',
      attestation: parseSasAttestation(SAS_PROGRAM_ID, bytes),
    });
  };
  vi.mocked(w.deps.gateway.completeSession).mockImplementation(
    () =>
      script({
        wallet: w.wallet,
        write,
        result: () => resultEvent(w.wallet, payload),
      }) as ReturnType<GatewayPort['completeSession']>,
  );
  hoisted.deps = w.deps;
  return { ...w, write };
}

async function resultEvent(wallet: Address, payload: Uint8Array): Promise<FlowEvent> {
  return {
    kind: 'result',
    result: {
      tier: 'A',
      tx: SIG,
      attestation: await attestationAddress(CREDENTIAL, SCHEMA, wallet),
      expiry: 99n,
      payloadHex: getBase16Codec().decode(payload),
    },
  };
}

/** Wallet -> persona -> consent -> approve, through the UI. */
async function approveConsent() {
  fireEvent.click(await screen.findByRole('button', { name: 'Start with a demo wallet' }));
  fireEvent.click(await screen.findByRole('radio', { name: /steady salary/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Request consent' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Approve & sign' }));
}

describe('BorrowPage', () => {
  it('starts at the wallet step and moves to the bank account step', async () => {
    hoisted.deps = (await world({ attestation: false })).deps;
    await renderApp('/borrow');
    fireEvent.click(await screen.findByRole('button', { name: 'Start with a demo wallet' }));
    expect(
      await screen.findByRole('heading', { name: 'Which bank account should we check?' }),
    ).toBeInTheDocument();
  });

  it('shows the result straight from chain for a wallet that already holds a valid tier', async () => {
    hoisted.deps = (await world({ attestation: liveAttestation() })).deps;
    await renderApp('/borrow');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/you.re tier A/i);
    expect(screen.getByRole('button', { name: 'Attest again' })).toBeInTheDocument();
    expect(screen.getByText(/already/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^transaction/i })).not.toBeInTheDocument();
  });

  it('goes back to the first step from Attest again', async () => {
    hoisted.deps = (await world({ attestation: liveAttestation() })).deps;
    await renderApp('/borrow');
    fireEvent.click(await screen.findByRole('button', { name: 'Attest again' }));
    expect(
      await screen.findByRole('heading', { name: 'Which wallet should hold the tier?' }),
    ).toBeInTheDocument();
  });

  it('shows the stages as they arrive, then the result with its transaction link', async () => {
    const gate = Promise.withResolvers<void>();
    await scripted(async function* ({ write, result }) {
      for (const event of STAGES) yield event;
      await gate.promise;
      await write();
      yield await result();
    });
    await renderApp('/borrow');
    await approveConsent();
    expect(
      await screen.findByRole('heading', { name: 'Checking your bank statement…' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(STAGE_COPY.submit.title)).toBeInTheDocument();
    gate.resolve();
    expect(
      await screen.findByRole('heading', { level: 1, name: /you.re tier A/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^transaction/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attest again' })).not.toBeInTheDocument();
  });

  it('shows the reject view for a REJECT result', async () => {
    await scripted(async function* () {
      for (const event of STAGES.slice(0, 4)) yield event;
      yield { kind: 'result', result: { tier: 'REJECT' } };
    });
    await renderApp('/borrow');
    await approveConsent();
    expect(await screen.findByRole('heading', { name: 'No tier this time' })).toBeInTheDocument();
  });

  it('shows the recovering card when the stream drops with a network error', async () => {
    await scripted(async function* () {
      yield STAGES[0] as FlowEvent;
      yield { kind: 'error', error: { code: 'network' } };
    });
    await renderApp('/borrow');
    await approveConsent();
    expect(
      await screen.findByRole('heading', { name: 'Connection lost — checking the chain…' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start again' })).toBeInTheDocument();
  });

  it('shows an error card with Start again for an expired session', async () => {
    await scripted(async function* () {
      yield STAGES[0] as FlowEvent;
      yield { kind: 'error', error: { code: 'session_expired' } };
    });
    await renderApp('/borrow');
    await approveConsent();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(
      await screen.findByRole('heading', { name: 'Which wallet should hold the tier?' }),
    ).toBeInTheDocument();
  });
});

/** The chain read polls every 3 s on real timers; give a confirmation one poll and some slack. */
const ONE_POLL = { timeout: 6_000 };

describe('BorrowPage against the chain', () => {
  it('reads a reported tier back from Solana before showing it', async () => {
    const { write } = await scripted(async function* ({ result }) {
      for (const event of STAGES) yield event;
      yield await result(); // the gateway reports first; the chain read still lags
    });
    await renderApp('/borrow');
    await approveConsent();
    expect(
      await screen.findByRole('heading', { name: /reading your tier back from solana/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /you.re tier/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Attested')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start again' })).toBeInTheDocument();
    await write();
    expect(
      await screen.findByRole('heading', { level: 1, name: /you.re tier A/i }, ONE_POLL),
    ).toBeInTheDocument();
    expect(await screen.findByText(/accepted by 2 pools/i)).toBeInTheDocument();
  }, 10_000);

  it('after a dropped stream, shows the tier once it lands on chain', async () => {
    const { write } = await scripted(async function* () {
      yield STAGES[0] as FlowEvent;
      yield { kind: 'error', error: { code: 'network' } };
    });
    await renderApp('/borrow');
    await approveConsent();
    await screen.findByRole('heading', { name: 'Connection lost — checking the chain…' });
    await write();
    expect(
      await screen.findByRole('heading', { level: 1, name: /you.re tier A/i }, ONE_POLL),
    ).toBeInTheDocument();
  }, 10_000);

  it.each([
    // Tier C (byte 3) for the old record, so showing it by mistake can't pass as the new tier A.
    ['stale', (now: bigint) => liveAttestation({ tier: 3, issuedAt: now - 2_600_000n })],
    [
      'expired',
      (now: bigint) => ({
        ...liveAttestation({ tier: 3, issuedAt: now - 2_000n }),
        expiry: now - 10n,
      }),
    ],
  ])(
    'after a dropped stream, shows the new tier for a wallet that held a %s one',
    async (_, old) => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const { write } = await scripted(
        async function* () {
          yield STAGES[0] as FlowEvent;
          yield { kind: 'error', error: { code: 'network' } };
        },
        { attestation: old(now) },
      );
      await renderApp('/borrow');
      await approveConsent();
      await screen.findByRole('heading', { name: 'Connection lost — checking the chain…' });
      await write();
      expect(
        await screen.findByRole('heading', { level: 1, name: /you.re tier A/i }, ONE_POLL),
      ).toBeInTheDocument();
    },
    10_000,
  );

  it('shows a plain error, not "checking the chain", for a failure before anything was sent', async () => {
    await scripted(async function* () {}, {
      gateway: { createSession: async () => fail({ code: 'network' }) },
    });
    await renderApp('/borrow');
    fireEvent.click(await screen.findByRole('button', { name: 'Start with a demo wallet' }));
    fireEvent.click(await screen.findByRole('radio', { name: /steady salary/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Request consent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/network/i);
    expect(screen.queryByText(/checking the chain/i)).not.toBeInTheDocument();
  });

  it('checks the wallet on chain before offering the first step', async () => {
    const w = await world({ attestation: false });
    vi.mocked(w.deps.chain.accounts).mockImplementation(() => new Promise(() => {}));
    hoisted.deps = w.deps;
    await renderApp('/borrow');
    expect(await screen.findByText('Checking this wallet on Solana…')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start with a demo wallet' }),
    ).not.toBeInTheDocument();
  });

  it('links "Anyone can check it" to the verify page when the verify flag is on', async () => {
    const w = await world({
      attestation: liveAttestation(),
      features: { verify: true, book: false },
    });
    hoisted.deps = w.deps;
    await renderApp('/borrow');
    expect(await screen.findByRole('link', { name: /anyone can check it/i })).toHaveAttribute(
      'href',
      `/verify?wallet=${w.wallet}`,
    );
  });

  it('turns consent into the expired card when the window runs out in the page', async () => {
    const expires = BigInt(Math.floor(Date.now() / 1000) + 2);
    await scripted(async function* () {}, {
      gateway: {
        createSession: async (wallet) =>
          ok({
            sessionId: 'sid',
            intent: buildIntent({
              sessionId: 'sid',
              wallet,
              policyHashHex: '11'.repeat(32),
              expires,
            }),
            intentExpires: expires,
          }),
      },
    });
    await renderApp('/borrow');
    fireEvent.click(await screen.findByRole('button', { name: 'Start with a demo wallet' }));
    fireEvent.click(await screen.findByRole('radio', { name: /steady salary/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Request consent' }));
    await screen.findByRole('button', { name: 'Approve & sign' });
    expect(
      await screen.findByRole('heading', { name: 'Consent window closed' }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start again' })).toBeInTheDocument();
  }, 10_000);
});
