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

import { SiteHeader } from './site-header.tsx';

async function renderHeader(features = { book: false, verify: false }) {
  hoisted.deps = (await world({ features })).deps;
  return renderWithRouter(<SiteHeader />);
}

describe('SiteHeader', () => {
  it('is the page banner with a Borrow link to /borrow', async () => {
    await renderHeader();
    expect(await screen.findByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /borrow/i })).toHaveAttribute('href', '/borrow');
  });

  it('marks the network as DEVNET and offers a theme toggle', async () => {
    await renderHeader();
    expect(await screen.findByText('DEVNET')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument();
  });

  it('hides Loan book and Verify while their flags are off', async () => {
    await renderHeader();
    await screen.findByRole('banner');
    expect(screen.queryByRole('link', { name: /loan book/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /verify/i })).not.toBeInTheDocument();
  });

  it('shows Loan book when the book flag is on, and not Verify', async () => {
    await renderHeader({ book: true, verify: false });
    expect(await screen.findByRole('link', { name: /loan book/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /verify/i })).not.toBeInTheDocument();
  });

  it('shows Verify when the verify flag is on, and not Loan book', async () => {
    await renderHeader({ book: false, verify: true });
    expect(await screen.findByRole('link', { name: /verify/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /loan book/i })).not.toBeInTheDocument();
  });
});
