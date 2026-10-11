import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { SiteLayout } from './site-layout.tsx';

describe('SiteLayout', () => {
  beforeEach(async () => {
    hoisted.deps = (await world()).deps;
  });

  it('wraps the page in a header and a footer', async () => {
    await renderWithRouter(<SiteLayout />);
    expect(await screen.findByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });
});
