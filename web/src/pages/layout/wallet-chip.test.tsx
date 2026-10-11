import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

  it('says the wallet is devnet-only and made in this tab', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<WalletChip />);
    expect(await screen.findByText(/made in this tab/i)).toBeInTheDocument();
    expect(screen.getByText(/devnet/i)).toBeInTheDocument();
  });
});
