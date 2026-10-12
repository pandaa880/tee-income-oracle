import { fireEvent, screen, within } from '@testing-library/react';
import {
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  signBytes,
  type KeyPairSigner,
} from '@solana/kit';
import { getLoanDecoder } from '@tio/demo-pool-client';
import { describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../app/deps.ts';
import { credentialMessage } from '../../domain/credential-copy.ts';
import { explorerAddressUrl } from '../../domain/explorer.ts';
import type { GatewayPort, RelayPort } from '../../domain/ports.ts';
import { fakeGateway, INFO, ok } from '../../test-support/fakes.ts';
import { loanBytes } from '../../test-support/fixtures.ts';
import { ledgerValue } from '../../test-support/ledger.ts';
import { renderApp } from '../../test-support/render.tsx';
import { liveAttestation, world, type WorldOptions } from '../../test-support/world.ts';

const hoisted = vi.hoisted(() => ({ deps: undefined as Deps | undefined }));
vi.mock('../../app/deps.ts', () => ({
  realDeps: () => {
    if (hoisted.deps === undefined) throw new Error('test deps not set');
    return hoisted.deps;
  },
}));

// Pool limits of 5,000 / 3,000 / 1,000 tokens (6 decimals).
const LIMITS = [5_000_000_000n, 3_000_000_000n, 1_000_000_000n];

async function open(options: WorldOptions = {}, path = '/loan?pool=0') {
  const w = await world({
    attestation: liveAttestation(),
    poolParams: { tierLimits: LIMITS },
    ...options,
  });
  hoisted.deps = w.deps;
  const app = await renderApp(path);
  return { ...w, ...app };
}
const amountBox = () => screen.findByRole('textbox', { name: 'Amount' });

describe('LoanPage tabs', () => {
  it('has one tab per pool, labelled by the limit for this wallet', async () => {
    await open();
    expect(await screen.findByRole('tab', { name: 'Pool 0 · up to 5,000' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Pool 1 · up to 5,000' })).toBeInTheDocument();
  });

  it('explains what the pool stands for, and that real loans are different', async () => {
    await open();
    expect(await screen.findByText(/this pool stands in for an NBFC/i)).toBeInTheDocument();
    expect(
      screen.getByText(/real indian loans are disbursed by a regulated NBFC/i),
    ).toBeInTheDocument();
  });

  it('switches pool in the URL when another tab is chosen', async () => {
    const { router } = await open();
    const tab = await screen.findByRole('tab', { name: /pool 1/i });
    fireEvent.mouseDown(tab, { button: 0 });
    await vi.waitFor(() => expect(tab).toHaveAttribute('aria-selected', 'true'));
    expect(router.state.location.search).toMatchObject({ pool: 1 });
  });

  it('labels a pool that does not lend to the wallet tier', async () => {
    await open({
      attestation: liveAttestation({ tier: 3 }),
      poolParams1: { tierLimits: [5_000_000_000n, 3_000_000_000n, 0n] },
    });
    expect(await screen.findByRole('tab', { name: 'Pool 1 · not for tier C' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pool 0 · up to 1,000' })).toBeInTheDocument();
  });

  it('labels the tabs "no tier" when the wallet has no attestation', async () => {
    await open({ attestation: false });
    expect(await screen.findByRole('tab', { name: 'Pool 0 · no tier' })).toBeInTheDocument();
  });
});

describe('PoolPanel with a valid tier and no loan', () => {
  it('shows the borrow form with the limit of the tier', async () => {
    await open();
    expect(await screen.findByText('Your limit · tier A')).toBeInTheDocument();
    expect(await amountBox()).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your open loan' })).not.toBeInTheDocument();
  });

  it('disables Borrow with a reason for an empty amount and for one above the limit', async () => {
    await open();
    const box = await amountBox();
    expect(screen.getByRole('button', { name: 'Borrow' })).toBeDisabled();
    fireEvent.change(box, { target: { value: '5001' } });
    expect(screen.getByRole('button', { name: /^Borrow/ })).toBeDisabled();
    expect(screen.getByText(/above your limit/i)).toBeInTheDocument();
  });

  it('fills Max with the limit when the vault holds more', async () => {
    await open();
    const box = await amountBox();
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    expect(box).toHaveValue('5000');
  });

  it('fills Max with the vault balance when the vault holds less than the limit', async () => {
    await open({ vault: { 0: 1_250_000_000n } });
    const box = await amountBox();
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    expect(box).toHaveValue('1250');
  });

  it('sends the typed amount to the relayer', async () => {
    const relayer = await generateKeyPairSigner();
    const relay: RelayPort = { relay: vi.fn<RelayPort['relay']>(async () => ok('x'.repeat(88))) };
    await open({
      overrides: { relay },
      gateway: {
        info: vi.fn<GatewayPort['info']>(async () => ok({ ...INFO, relayer: relayer.address })),
      },
    });
    const box = await amountBox();
    fireEvent.change(box, { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Borrow 2.5 tokens' }));
    await vi.waitFor(() => expect(relay.relay).toHaveBeenCalledTimes(1));
  });
});

describe('PoolPanel with an open loan', () => {
  it('shows the loan with Repay instead of the form', async () => {
    const { loanAddress } = await open({ loan: 2_500_000_000n });
    expect(await screen.findByRole('heading', { name: 'Your open loan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repay 2,500 tokens' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Loan account' })).toHaveAttribute(
      'href',
      explorerAddressUrl('devnet', loanAddress),
    );
    expect(ledgerValue('PRINCIPAL')).toContain('2,500');
    expect(screen.queryByRole('textbox', { name: 'Amount' })).not.toBeInTheDocument();
  });

  it('repays through the relayer and confirms that the tier is still valid', async () => {
    const relayer: KeyPairSigner = await generateKeyPairSigner();
    const w = await world({
      attestation: liveAttestation(),
      poolParams: { tierLimits: LIMITS },
      loan: 2_500_000_000n,
    });
    const relay: RelayPort = {
      relay: vi.fn<RelayPort['relay']>(async (txB64) => {
        const wire = Uint8Array.from(getBase64Encoder().encode(txB64));
        const { messageBytes } = getTransactionDecoder().decode(wire);
        w.store.delete(w.loanAddress);
        const signature = await signBytes(relayer.keyPair.privateKey, messageBytes);
        return ok(getBase58Decoder().decode(signature));
      }),
    };
    hoisted.deps = {
      ...w.deps,
      relay,
      gateway: fakeGateway({ info: async () => ok({ ...INFO, relayer: relayer.address }) }),
    };
    await renderApp('/loan?pool=0');
    fireEvent.click(await screen.findByRole('button', { name: 'Repay 2,500 tokens' }));
    expect(await screen.findByText(/loan repaid\. your tier is still valid/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /transaction/i })).toBeInTheDocument();
    expect(relay.relay).toHaveBeenCalledTimes(1);
  });
});

describe('PoolPanel when the credential is not usable', () => {
  it('asks to re-attest a stale tier, with no borrow form', async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await open({ attestation: liveAttestation({ issuedAt: now - 3_000_000n }) });
    expect(
      await screen.findByRole('heading', { name: credentialMessage('stale').title }),
    ).toBeInTheDocument();
    expect(screen.getByText('STALE')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Re-attest' })).toHaveAttribute('href', '/borrow');
    expect(screen.queryByRole('textbox', { name: 'Amount' })).not.toBeInTheDocument();
  });

  it('offers Get a tier when the wallet has no attestation', async () => {
    await open({ attestation: false });
    expect(await screen.findByRole('link', { name: 'Get a tier' })).toHaveAttribute(
      'href',
      '/borrow',
    );
    expect(screen.queryByRole('textbox', { name: 'Amount' })).not.toBeInTheDocument();
  });

  it('shows no form and no re-attest for a tier the pool does not accept', async () => {
    await open({
      attestation: liveAttestation({ tier: 3 }),
      poolParams: { tierLimits: [5_000_000_000n, 3_000_000_000n, 0n] },
    });
    expect(
      await screen.findByRole('heading', { name: credentialMessage('tier_not_accepted').title }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Amount' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Re-attest' })).not.toBeInTheDocument();
  });

  it('shows the active panel only inside the selected tab', async () => {
    await open({ attestation: false });
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByRole('link', { name: 'Get a tier' })).toBeInTheDocument();
  });
});

/** A relayer that co-signs whatever it's sent and lets `land` change the chain, like the real one. */
async function relaying(
  land: (w: Awaited<ReturnType<typeof world>>) => void,
  options: WorldOptions,
) {
  const relayer = await generateKeyPairSigner();
  const w = await world({
    attestation: liveAttestation(),
    poolParams: { tierLimits: LIMITS },
    ...options,
  });
  const relay: RelayPort = {
    relay: vi.fn<RelayPort['relay']>(async (txB64) => {
      const { messageBytes } = getTransactionDecoder().decode(
        Uint8Array.from(getBase64Encoder().encode(txB64)),
      );
      land(w);
      const signature = await signBytes(relayer.keyPair.privateKey, messageBytes);
      return ok(getBase58Decoder().decode(signature));
    }),
  };
  hoisted.deps = {
    ...w.deps,
    relay,
    gateway: fakeGateway({ info: async () => ok({ ...INFO, relayer: relayer.address }) }),
  };
  return w;
}

describe('PoolPanel after review', () => {
  it('keeps Repay for an open loan when the tier went stale', async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await open({
      loan: 2_500_000_000n,
      attestation: liveAttestation({ issuedAt: now - 3_000_000n }),
    });
    expect(await screen.findByRole('button', { name: 'Repay 2,500 tokens' })).toBeInTheDocument();
    // Repay shows from the pool read alone; the badge follows once the credential read lands.
    expect(await screen.findByText('STALE')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Re-attest' })).not.toBeInTheDocument();
  });

  it('borrows, then shows the open loan with a receipt for the borrow', async () => {
    await relaying(
      (w) =>
        w.store.set(w.loanAddress, {
          kind: 'loan',
          loan: getLoanDecoder().decode(loanBytes(w.wallet, 2_500_000_000n)),
        }),
      {},
    );
    await renderApp('/loan?pool=0');
    fireEvent.change(await amountBox(), { target: { value: '2500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Borrow 2,500 tokens' }));
    expect(await screen.findByText(/borrowed 2,500 tokens/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your open loan' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Transaction' })).toBeInTheDocument();
  });
});

describe('PoolPanel repay with an unusable tier', () => {
  it('confirms the repay without claiming the stale tier is still valid', async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await relaying((w) => w.store.delete(w.loanAddress), {
      loan: 2_500_000_000n,
      attestation: liveAttestation({ issuedAt: now - 3_000_000n }),
    });
    await renderApp('/loan?pool=0');
    fireEvent.click(await screen.findByRole('button', { name: 'Repay 2,500 tokens' }));
    expect(await screen.findByText(/^loan repaid\./i)).toBeInTheDocument();
    expect(screen.queryByText(/still valid/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Re-attest' })).toBeInTheDocument();
  });
});
