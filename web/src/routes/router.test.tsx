import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Deps } from '../app/deps.ts';
import { renderApp } from '../test-support/render.tsx';
import { world } from '../test-support/world.ts';

// Pages call the hooks with their default `realDeps()`; swap it for fakes so no network or env is needed.
const hoisted = vi.hoisted(() => ({ deps: undefined as Deps | undefined }));
vi.mock('../app/deps.ts', () => ({
  realDeps: () => {
    if (hoisted.deps === undefined) throw new Error('test deps not set');
    return hoisted.deps;
  },
}));

async function renderAt(path: string) {
  hoisted.deps = (await world()).deps;
  return renderApp(path);
}

describe('app router', () => {
  it('renders the landing page at /', async () => {
    await renderAt('/');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      /years of real income/i,
    );
  });

  it('renders the wallet step at /borrow', async () => {
    await renderAt('/borrow');
    expect(
      await screen.findByRole('heading', { name: /which wallet should hold the tier/i }),
    ).toBeInTheDocument();
  });

  it('renders the loan screen at /loan?pool=1 with the Pool 1 tab selected', async () => {
    await renderAt('/loan?pool=1');
    const tab = await screen.findByRole('tab', { name: /pool 1/i });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /pool 0/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('selects Pool 0 on /loan without a pool param', async () => {
    await renderAt('/loan');
    expect(await screen.findByRole('tab', { name: /pool 0/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it.each(['/loan?pool=7', '/loan?pool=abc', '/loan?pool=-1'])(
    'falls back to Pool 0 for a bad pool param (%s)',
    async (path) => {
      await renderAt(path);
      expect(await screen.findByRole('tab', { name: /pool 0/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.queryByRole('tab', { name: /pool 7/i })).not.toBeInTheDocument();
    },
  );

  it('wraps every page in the site layout: a header with a Borrow link', async () => {
    await renderAt('/');
    const banner = await screen.findByRole('banner');
    expect(banner).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /borrow/i }).length).toBeGreaterThan(0);
  });

  it('hides the Loan book and Verify links while their flags are off', async () => {
    await renderAt('/');
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('link', { name: /borrow/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /loan book|verify/i })).not.toBeInTheDocument();
  });
});
