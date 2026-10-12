import { fireEvent, screen } from '@testing-library/react';
import { getLoanDecoder } from '@tio/demo-pool-client';
import { describe, expect, it, vi } from 'vitest';
import { messageFor } from '../../domain/errors.ts';
import { credentialLabel, credentialMessage } from '../../domain/credential-copy.ts';
import type { CredentialStatus } from '../../domain/credential.ts';
import { explorerAddressUrl } from '../../domain/explorer.ts';
import { ADMIN, loanBytes, POOL_0 } from '../../test-support/fixtures.ts';
import { ledgerValue } from '../../test-support/ledger.ts';
import { renderWithRouter } from '../../test-support/render.tsx';
import { BorrowForm } from './borrow-form.tsx';
import { CredentialCard } from './credential-card.tsx';
import { OpenLoan } from './open-loan.tsx';

const LIMIT = 5_000_000_000n;
const VAULT = 9_000_000_000n;

async function form(props: Partial<Parameters<typeof BorrowForm>[0]> = {}) {
  const onBorrow = vi.fn<(amount: bigint) => void>();
  await renderWithRouter(
    <BorrowForm
      tier="A"
      limit={LIMIT}
      vault={VAULT}
      pending={false}
      error={null}
      onBorrow={onBorrow}
      {...props}
    />,
  );
  await screen.findByRole('textbox', { name: 'Amount' });
  return { onBorrow };
}
const amountBox = () => screen.getByRole('textbox', { name: 'Amount' });
const type = (value: string) => fireEvent.change(amountBox(), { target: { value } });
const reason = (error: Parameters<typeof messageFor>[0]) => messageFor(error).detail;

describe('BorrowForm', () => {
  it('shows the limit of the tier and what the pool has available', async () => {
    await form();
    expect(screen.getByText('Your limit · tier A')).toBeInTheDocument();
    expect(screen.getByText('5,000')).toBeInTheDocument();
    expect(ledgerValue('Pool has available')).toBe('9,000');
    expect(ledgerValue('Due date / fee')).toMatch(/none in this demo pool/i);
    expect(ledgerValue('Network fees')).toMatch(/paid by the demo relayer/i);
  });

  it('has a labelled decimal amount input', async () => {
    await form();
    expect(amountBox()).toHaveAttribute('inputmode', 'decimal');
  });

  it('disables Borrow with the reason while the amount is empty', async () => {
    await form();
    expect(screen.getByRole('button', { name: 'Borrow' })).toBeDisabled();
    expect(
      screen.getByText(reason({ code: 'invalid_amount', reason: 'empty' })),
    ).toBeInTheDocument();
  });

  it('disables Borrow above the ceiling and says so', async () => {
    await form();
    type('5000.5');
    expect(screen.getByRole('button', { name: /^Borrow/ })).toBeDisabled();
    expect(
      screen.getByText(reason({ code: 'invalid_amount', reason: 'over_limit' })),
    ).toBeInTheDocument();
  });

  it('disables Borrow for more than 6 decimals', async () => {
    await form();
    type('1.1234567');
    expect(screen.getByRole('button', { name: /^Borrow/ })).toBeDisabled();
    expect(
      screen.getByText(reason({ code: 'invalid_amount', reason: 'too_many_decimals' })),
    ).toBeInTheDocument();
  });

  it('names the amount on the button and borrows it in base units', async () => {
    const { onBorrow } = await form();
    type('2500');
    const button = screen.getByRole('button', { name: 'Borrow 2,500 tokens' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onBorrow).toHaveBeenCalledExactlyOnceWith(2_500_000_000n);
  });

  it('allows exactly the ceiling', async () => {
    await form();
    type('5000');
    expect(screen.getByRole('button', { name: 'Borrow 5,000 tokens' })).toBeEnabled();
  });

  it('fills Max with the plain limit when the pool has more', async () => {
    await form();
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    expect(amountBox()).toHaveValue('5000');
  });

  it('fills Max with the vault balance when the pool has less than the limit', async () => {
    await form({ vault: 2_500_000_000n });
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    expect(amountBox()).toHaveValue('2500');
  });

  it('keeps Borrow disabled and says Sending… while pending', async () => {
    await form({ pending: true });
    type('10');
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  });

  it('shows a failure as an error card', async () => {
    await form({ error: { code: 'simulation_failed', custom: 6007 } });
    expect(screen.getByRole('alert')).toHaveTextContent(
      messageFor({ code: 'simulation_failed', custom: 6007 }).title,
    );
  });
});

describe('OpenLoan', () => {
  const loan = getLoanDecoder().decode(loanBytes(ADMIN, 2_500_000_000n));

  async function open(props: Partial<Parameters<typeof OpenLoan>[0]> = {}) {
    const onRepay = vi.fn<() => void>();
    await renderWithRouter(
      <OpenLoan
        loan={loan}
        status="valid"
        pending={false}
        error={null}
        cluster="devnet"
        loanAddress={POOL_0}
        onRepay={onRepay}
        {...props}
      />,
    );
    await screen.findByRole('heading', { name: 'Your open loan' });
    return { onRepay };
  }

  it('shows the principal, the tier at borrow and how old the tier was', async () => {
    await open();
    expect(ledgerValue('PRINCIPAL')).toContain('2,500');
    expect(ledgerValue('TIER AT BORROW')).toContain('A');
    expect(ledgerValue('BORROWED')).toBeTruthy();
    expect(ledgerValue('TIER AGE AT BORROW')).toBe('16 min');
  });

  it.each([
    ['valid', 'FRESH'],
    ['stale', 'STALE'],
  ] as const)('badges a %s credential as %s', async (status, label) => {
    await open({ status });
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('repays the full amount', async () => {
    const { onRepay } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Repay 2,500 tokens' }));
    expect(onRepay).toHaveBeenCalledOnce();
  });

  it('disables Repay while pending', async () => {
    await open({ pending: true });
    expect(screen.getByRole('button', { name: /repay|sending/i })).toBeDisabled();
  });

  it('links the loan account on the explorer', async () => {
    await open();
    expect(screen.getByRole('link', { name: 'Loan account' })).toHaveAttribute(
      'href',
      explorerAddressUrl('devnet', POOL_0),
    );
  });

  it('shows a failure as an error card', async () => {
    await open({ error: { code: 'network' } });
    expect(screen.getByRole('alert')).toHaveTextContent(messageFor({ code: 'network' }).title);
  });
});

const show = async (status: CredentialStatus) => {
  await renderWithRouter(<CredentialCard status={status} />);
  await screen.findByText(credentialLabel(status));
};

describe('CredentialCard', () => {
  it.each([
    'stale',
    'expired',
    'foreign_signer',
    'enclave_revoked',
    'not_approved',
    'policy_mismatch',
    'window_too_old',
    'window_too_short',
  ] as const)('explains %s and offers Re-attest on /borrow', async (status) => {
    await show(status);
    expect(
      screen.getByRole('heading', { name: credentialMessage(status).title }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Re-attest' })).toHaveAttribute('href', '/borrow');
    expect(screen.queryByRole('link', { name: 'Get a tier' })).not.toBeInTheDocument();
  });

  it('offers Get a tier when the wallet has none', async () => {
    await show('none');
    expect(screen.getByRole('link', { name: 'Get a tier' })).toHaveAttribute('href', '/borrow');
    expect(screen.queryByRole('link', { name: 'Re-attest' })).not.toBeInTheDocument();
  });

  it('only explains a tier the pool does not accept', async () => {
    await show('tier_not_accepted');
    expect(
      screen.getByRole('heading', { name: credentialMessage('tier_not_accepted').title }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
