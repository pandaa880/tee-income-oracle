import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BorrowView } from '../../domain/borrow-view.ts';
import { explorerAddressUrl, explorerTxUrl } from '../../domain/explorer.ts';
import { formatUnixDate } from '../../domain/format.ts';
import { decodePayload } from '@tio/oracle-client/attest';
import { SIG } from '../../test-support/fakes.ts';
import { NOW, OTHER, payloadBytes } from '../../test-support/fixtures.ts';
import { ledgerValue } from '../../test-support/ledger.ts';
import { renderWithRouter } from '../../test-support/render.tsx';
import { RejectView } from './reject-view.tsx';
import { ResultView } from './result-view.tsx';

type Result = Extract<BorrowView, { step: 'result' }>;
const record = {
  payload: decodePayload(payloadBytes({ tier: 2, measurementId: 4 })),
  expiry: NOW + 10_000n,
};
const streamResult: Result = {
  step: 'result',
  source: 'stream',
  tier: 'B',
  attestation: OTHER,
  tx: SIG,
  record,
};
const both = [
  { poolId: 0, limit: 5_000_000_000n },
  { poolId: 1, limit: 3_000_000_000n },
];

async function show(props: Partial<Parameters<typeof ResultView>[0]> = {}) {
  const onReset = vi.fn<() => void>();
  await renderWithRouter(
    <ResultView
      result={streamResult}
      pools={both}
      matchesPersona={null}
      cluster="devnet"
      verifyHref={null}
      onReset={onReset}
      {...props}
    />,
  );
  await screen.findByRole('heading', { level: 1 });
  return { onReset };
}

describe('ResultView', () => {
  it('announces the tier with a seal and a headline', async () => {
    await show();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/you.re tier B/i);
    expect(screen.getAllByText('B').length).toBeGreaterThan(0);
    expect(screen.getByText('Show lenders this tier, not your statement.')).toBeInTheDocument();
  });

  it('lists the pools that accept the tier with their limits', async () => {
    await show();
    expect(screen.getByText(/accepted by 2 pools/i)).toHaveTextContent(
      'Pool 0 up to 5,000 · Pool 1 up to 3,000',
    );
  });

  it('uses the singular for one pool', async () => {
    await show({ pools: [{ poolId: 1, limit: 3_000_000_000n }] });
    expect(screen.getByText(/accepted by 1 pool\b/i)).toHaveTextContent('Pool 1 up to 3,000');
    expect(screen.queryByText(/1 pools/i)).not.toBeInTheDocument();
  });

  it.each([
    [true, true],
    [false, false],
    [null, false],
  ])('matchesPersona %s -> match line shown: %s', async (matchesPersona, shown) => {
    await show({ matchesPersona });
    const line = screen.queryByText('Matches what this test account was built to score.');
    expect(line !== null).toBe(shown);
  });

  it('writes the on-chain record into a ledger', async () => {
    await show();
    expect(ledgerValue('ISSUED')).toContain(formatUnixDate(record?.payload.issuedAt ?? 0n));
    expect(ledgerValue('EXPIRES')).toBeTruthy();
    expect(ledgerValue('ENCLAVE BUILD')).toContain('#4');
    expect(ledgerValue('POLICY')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: "What's stored on chain (83 bytes)" }),
    ).toBeInTheDocument();
  });

  it('says it is still reading the pools while a pool read lags behind', async () => {
    await show({ pools: null });
    expect(screen.getByText(/reading the pools/i)).toBeInTheDocument();
    expect(screen.queryByText(/accepted by/i)).not.toBeInTheDocument();
  });

  it('says so when no pool lends to the tier', async () => {
    await show({ pools: [] });
    expect(screen.getByText(/no pool lends to this tier/i)).toBeInTheDocument();
  });

  it('links the attestation and the transaction on the explorer', async () => {
    await show();
    const attestation = screen.getByRole('link', { name: /attestation on explorer/i });
    expect(attestation).toHaveAttribute('href', explorerAddressUrl('devnet', OTHER));
    expect(attestation).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByRole('link', { name: /transaction/i })).toHaveAttribute(
      'href',
      explorerTxUrl('devnet', SIG),
    );
  });

  it('leaves out the transaction link when there is no transaction', async () => {
    await show({ result: { ...streamResult, tx: null } });
    expect(screen.getByRole('link', { name: /attestation on explorer/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /transaction/i })).not.toBeInTheDocument();
  });

  it('links "Anyone can check it" only with a verify target', async () => {
    await show();
    expect(screen.queryByRole('link', { name: /anyone can check it/i })).not.toBeInTheDocument();
  });

  it('links "Anyone can check it" to the verify target when given', async () => {
    await show({ verifyHref: '/verify?wallet=abc' });
    expect(screen.getByRole('link', { name: /anyone can check it/i })).toHaveAttribute(
      'href',
      '/verify?wallet=abc',
    );
  });

  it('says what the tier is and is not', async () => {
    await show();
    expect(screen.getByText(/not a credit score/i)).toHaveTextContent(/lasts 30 days/i);
  });

  it('leads to the loan screen on pool 0', async () => {
    await show();
    expect(screen.getByRole('link', { name: 'Borrow now' })).toHaveAttribute(
      'href',
      '/loan?pool=0',
    );
  });

  it('offers no re-attest for a fresh stream result', async () => {
    await show();
    expect(screen.queryByRole('button', { name: 'Attest again' })).not.toBeInTheDocument();
  });

  it('for a tier already on chain, says so and offers Attest again', async () => {
    const { onReset } = await show({ result: { ...streamResult, source: 'chain', tx: null } });
    expect(screen.getByText(/already/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Attest again' }));
    expect(onReset).toHaveBeenCalledOnce();
  });
});

describe('RejectView', () => {
  it('says no tier was issued and nothing was written', async () => {
    const onReset = vi.fn<() => void>();
    await renderWithRouter(<RejectView onReset={onReset} />);
    expect(await screen.findByText('NO TIER')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'No tier this time' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/doesn't pass the lender's published policy/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was written on chain/i)).toBeInTheDocument();
    expect(screen.getByText(/wiped/i)).toBeInTheDocument();
  });

  it('lets the borrower try another account', async () => {
    const onReset = vi.fn<() => void>();
    await renderWithRouter(<RejectView onReset={onReset} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try another account' }));
    expect(onReset).toHaveBeenCalledOnce();
  });
});
