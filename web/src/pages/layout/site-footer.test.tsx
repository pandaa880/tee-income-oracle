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

import { RELEASE } from '../../app/release.ts';
import { SiteFooter } from './site-footer.tsx';

describe('SiteFooter', () => {
  it('is the page footer with the release version', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<SiteFooter />);
    expect(await screen.findByRole('contentinfo')).toHaveTextContent(RELEASE);
  });

  it('links the source to the GitHub repository', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<SiteFooter />);
    expect(await screen.findByRole('link', { name: /source/i })).toHaveAttribute(
      'href',
      'https://github.com/pandaa880/tee-income-oracle',
    );
  });

  it('says what the demo is (devnet, simulated bank)', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<SiteFooter />);
    expect(await screen.findByRole('contentinfo')).toHaveTextContent(/devnet/i);
  });
});
