import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { generateKeyPairSigner } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import type { Deps } from '../app/deps.ts';
import { fakeChain, fakeDeps } from '../test-support/fakes.ts';

// Pages call the hooks with their default `realDeps()`; swap it for fakes so no network or env is needed.
const hoisted = vi.hoisted(() => ({ deps: undefined as Deps | undefined }));
vi.mock('../app/deps.ts', () => ({
  realDeps: () => {
    if (hoisted.deps === undefined) throw new Error('test deps not set');
    return hoisted.deps;
  },
}));

import { createAppRouter } from './router.tsx';

async function renderAt(path: string) {
  const key = await generateKeyPairSigner();
  hoisted.deps = fakeDeps(
    { address: key.address, signIntent: async () => new Uint8Array(64) as never, signer: key },
    fakeChain(new Map()),
  );
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('app router', () => {
  it('renders the landing page at /', async () => {
    await renderAt('/');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/prove it blind/i);
  });

  it('renders the borrow placeholder at /borrow with pool 0 by default', async () => {
    await renderAt('/borrow');
    expect(await screen.findByRole('heading', { name: /borrow/i })).toBeInTheDocument();
    expect(screen.getByText(/pool 0/i)).toBeInTheDocument();
  });

  it('reads the pool from the search params: /borrow?pool=1 shows pool 1', async () => {
    await renderAt('/borrow?pool=1');
    expect(await screen.findByText(/pool 1/i)).toBeInTheDocument();
  });

  it.each(['/borrow?pool=7', '/borrow?pool=abc', '/borrow?pool=-1'])(
    'falls back to pool 0 for a bad pool param (%s)',
    async (path) => {
      await renderAt(path);
      expect(await screen.findByText(/pool 0/i)).toBeInTheDocument();
      expect(screen.queryByText(/pool 7/i)).not.toBeInTheDocument();
    },
  );

  it('renders the flow as a stepper from the flow state', async () => {
    await renderAt('/borrow');
    await screen.findByRole('heading', { name: /borrow/i });
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
  });
});
