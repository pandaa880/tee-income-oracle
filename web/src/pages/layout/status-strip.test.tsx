import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../app/deps.ts';
import { renderWithRouter } from '../../test-support/render.tsx';
import type { GatewayPort } from '../../domain/ports.ts';
import { fail } from '../../test-support/fakes.ts';
import { world } from '../../test-support/world.ts';

const hoisted = vi.hoisted(() => ({ deps: undefined as Deps | undefined }));
vi.mock('../../app/deps.ts', () => ({
  realDeps: () => {
    if (hoisted.deps === undefined) throw new Error('test deps not set');
    return hoisted.deps;
  },
}));

import { StatusStrip } from './status-strip.tsx';

describe('StatusStrip', () => {
  it('shows the live strip with the enclave build and no alert', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<StatusStrip />);
    const strip = await screen.findByRole('status');
    await vi.waitFor(() => expect(strip).toHaveTextContent('LIVE ON DEVNET'));
    expect(strip).toHaveTextContent('ENCLAVE BUILD #0');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows each live fact as its own item, the state word in the positive tone', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<StatusStrip />);
    const state = await screen.findByText('LIVE ON DEVNET');
    expect(state).toHaveAttribute('data-tone', 'positive');
    expect(state.querySelector('[aria-hidden="true"]')).toHaveTextContent('●');
    expect(screen.getByText('ENCLAVE BUILD #0 · REGISTERED')).toBeInTheDocument();
    expect(screen.getByText('GATEWAY UP')).toBeInTheDocument();
  });

  it('reads as separate words, so a screen reader does not run the items together', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<StatusStrip />);
    await screen.findByText('LIVE ON DEVNET');
    expect(screen.getByRole('status')).toHaveTextContent(
      'LIVE ON DEVNET ENCLAVE BUILD #0 · REGISTERED GATEWAY UP',
    );
  });

  it('tones the state word negative when the enclave build is revoked', async () => {
    hoisted.deps = (await world({ revokedAt: 5n })).deps;
    await renderWithRouter(<StatusStrip />);
    expect(await screen.findByText('DOWN ON DEVNET')).toHaveAttribute('data-tone', 'negative');
  });

  it('shows DOWN and an alert naming the reason when the enclave build is revoked', async () => {
    hoisted.deps = (await world({ revokedAt: 5n })).deps;
    await renderWithRouter(<StatusStrip />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent?.length).toBeGreaterThan(10);
    expect(await screen.findByRole('status')).toHaveTextContent('DOWN');
  });

  it('shows an alert, not DOWN, when only the health check fails', async () => {
    hoisted.deps = (
      await world({
        gateway: { health: vi.fn<GatewayPort['health']>(async () => fail({ code: 'timeout' })) },
      })
    ).deps;
    await renderWithRouter(<StatusStrip />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('status')).not.toHaveTextContent('DOWN');
  });
});
