import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../app/deps.ts';
import { renderWithRouter } from '../../test-support/render.tsx';
import { world } from '../../test-support/world.ts';

const hoisted = vi.hoisted(() => ({ deps: undefined as Deps | undefined }));
vi.mock('../../app/deps.ts', () => ({
  realDeps: () => {
    if (hoisted.deps === undefined) throw new Error('test deps not set');
    return hoisted.deps;
  },
}));

import { shortAddress } from '../../domain/format.ts';
import { WalletChip } from './wallet-chip.tsx';

describe('WalletChip', () => {
  it('shows the demo wallet address in short form', async () => {
    const w = await world();
    hoisted.deps = w.deps;
    await renderWithRouter(<WalletChip />);
    expect(await screen.findByText(`DEMO WALLET · ${shortAddress(w.wallet)}`)).toBeInTheDocument();
  });

  it('says the wallet was made in this tab, and leaves DEVNET to the header badge', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<WalletChip />);
    expect(await screen.findByText('Made in this tab')).toBeInTheDocument();
    expect(screen.queryByText(/devnet only/i)).not.toBeInTheDocument();
  });

  it('copies the full address, not the short form, and says so', async () => {
    const w = await world();
    hoisted.deps = w.deps;
    const writeText = stubClipboard(async () => undefined);
    await renderWithRouter(<WalletChip />);
    fireEvent.click(await screen.findByRole('button', { name: /demo wallet/i }));
    expect(writeText).toHaveBeenCalledWith(w.wallet);
    expect(await screen.findByText('Address copied')).toBeInTheDocument();
  });

  it('goes back to "Made in this tab" a moment after copying', async () => {
    hoisted.deps = (await world()).deps;
    stubClipboard(async () => undefined);
    await renderWithRouter(<WalletChip />);
    fireEvent.click(await screen.findByRole('button', { name: /demo wallet/i }));
    await screen.findByText('Address copied');
    await vi.waitFor(() => expect(screen.getByText('Made in this tab')).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('says it could not copy when the clipboard refuses', async () => {
    hoisted.deps = (await world()).deps;
    stubClipboard(async () => {
      throw new Error('denied');
    });
    await renderWithRouter(<WalletChip />);
    fireEvent.click(await screen.findByRole('button', { name: /demo wallet/i }));
    expect(await screen.findByText('Couldn’t copy')).toBeInTheDocument();
  });

  it('names the copy action in its title', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<WalletChip />);
    expect(await screen.findByRole('button', { name: /demo wallet/i })).toHaveAttribute(
      'title',
      'Copy the full wallet address',
    );
  });
});

/** Replaces `navigator.clipboard` for one test (happy-dom's is not a spy). */
function stubClipboard(impl: (text: string) => Promise<void>) {
  const writeText = vi.fn<(text: string) => Promise<void>>(impl);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});
