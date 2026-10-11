import { screen, within } from '@testing-library/react';
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
import { RELEASE } from '../../app/release.ts';
import { HomePage } from './home-page.tsx';
import { Hero } from './hero.tsx';
import { HowItWorks } from './how-it-works.tsx';
import { Doors } from './doors.tsx';
import { FinalCta } from './final-cta.tsx';
import type { WorldOptions } from '../../test-support/world.ts';

const GITHUB = 'https://github.com/pandaa880/tee-income-oracle';
const BOTH_OFF = { book: false, verify: false };

async function renderHome(options: WorldOptions = {}) {
  hoisted.deps = (await world(options)).deps;
  await renderWithRouter(<HomePage />);
  await screen.findByRole('heading', { level: 1 });
}

describe('HomePage', () => {
  it('leads with the promise', async () => {
    await renderHome();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Years of real income, no credit file. Prove it without the statement.',
    );
  });

  it('offers the live demo as a link to /borrow, with the honest line under it', async () => {
    await renderHome();
    const cta = screen.getAllByRole('link', { name: /run the live demo/i })[0];
    expect(cta).toHaveAttribute('href', '/borrow');
    expect(
      screen.getByText('Devnet · simulated bank, real protocol · nothing to install'),
    ).toBeInTheDocument();
  });

  it('shows the enclave build number in the proof bar once the status is read', async () => {
    await renderHome();
    expect(await screen.findByText('Enclave build #0 registered on Solana')).toBeInTheDocument();
  });

  it('falls back to a number-free proof item while the status is loading', async () => {
    await renderHome({ gateway: { info: () => new Promise<never>(() => {}) } });
    expect(screen.getByText('Enclave build registered on Solana')).toBeInTheDocument();
  });

  it('shows the checkable proof items with their links', async () => {
    await renderHome();
    expect(screen.getByText(`Reproducible build, ${RELEASE}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open source' })).toHaveAttribute('href', GITHUB);
    expect(screen.getByText('Live on Solana devnet')).toBeInTheDocument();
  });

  it('says nothing is Live and links nowhere gated while the flags are off', async () => {
    await renderHome({ features: BOTH_OFF });
    expect(screen.queryAllByText(/^live$/i)).toHaveLength(0);
    expect(
      screen.queryByRole('link', { name: /loan book|verify a tier|verify any tier/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/verify any tier yourself/i)).not.toBeInTheDocument();
  });

  it('shows the loan book link when the book flag is on', async () => {
    await renderHome({ features: { book: true, verify: false } });
    expect(screen.getAllByRole('link', { name: /see the loan book/i }).length).toBeGreaterThan(0);
  });

  it('shows the verify proof item when the verify flag is on', async () => {
    await renderHome({ features: { book: false, verify: true } });
    expect(screen.getByText(/verify any tier yourself/i)).toBeInTheDocument();
  });

  it('makes no registration claim in the proof bar when the registry says the build was revoked', async () => {
    await renderHome({ revokedAt: 5n });
    await screen.findByRole('alert');
    expect(screen.queryByText(/registered on solana/i)).not.toBeInTheDocument();
  });

  it('makes no build claim when the status read itself failed', async () => {
    // A throw (not an error Result) fails the status query itself: STATUS UNKNOWN.
    await renderHome({
      gateway: {
        health: async () => {
          throw new Error('status read blew up');
        },
      },
    });
    expect(await screen.findByText('STATUS UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText(/registered on solana/i)).not.toBeInTheDocument();
  });

  it('disables the hero CTA instead of linking when the service is down', async () => {
    await renderHome({ revokedAt: 5n });
    const ctas = await screen.findAllByRole('button', { name: /run the live demo/i });
    expect(ctas).toHaveLength(2);
    for (const cta of ctas) expect(cta).toBeDisabled();
    expect(screen.queryByRole('link', { name: /run the live demo/i })).not.toBeInTheDocument();
  });
});

describe('Hero', () => {
  it('links the primary CTA to /borrow when the demo is available', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<Hero ctaDisabledReason={null} />);
    expect(await screen.findByRole('link', { name: 'Run the live demo' })).toHaveAttribute(
      'href',
      '/borrow',
    );
  });

  it('replaces the link with a disabled button and shows the reason', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<Hero ctaDisabledReason="The enclave build was revoked." />);
    expect(await screen.findByRole('button', { name: 'Run the live demo' })).toBeDisabled();
    expect(screen.getByText('The enclave build was revoked.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Run the live demo' })).not.toBeInTheDocument();
  });
});

describe('HowItWorks', () => {
  beforeEach(async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<HowItWorks />);
  });

  it('explains the flow in four numbered steps', async () => {
    expect(
      await screen.findByRole('heading', { level: 2, name: 'From consent to loan in four steps' }),
    ).toBeInTheDocument();
    const steps = screen.getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    const starts = ['Consent', 'Verify blind', 'Attest', 'Lend'];
    steps.forEach((step, i) => expect(step.textContent).toMatch(new RegExp(`^\\W*${starts[i]}`)));
  });

  it('draws where the data travels and says the browser sees only the consent', async () => {
    expect(await screen.findByRole('img')).toBeInTheDocument();
    expect(screen.getByText('Your browser sees only the consent.')).toBeInTheDocument();
  });
});

const renderDoors = async (features: { book: boolean; verify: boolean }) => {
  hoisted.deps = (await world({ features })).deps;
  await renderWithRouter(<Doors features={features} />);
  await screen.findByRole('heading', { name: 'Try the borrower flow' });
};
const lenderDoor = () =>
  within(
    screen
      .getByRole('heading', { name: 'Built for NBFCs and the credit vehicles that fund them' })
      .closest('article, section') as HTMLElement,
  );

describe('Doors', () => {
  it('sends the borrower door to /borrow', async () => {
    await renderDoors(BOTH_OFF);
    const door = within(
      screen
        .getByRole('heading', { name: 'Try the borrower flow' })
        .closest('article, section') as HTMLElement,
    );
    expect(door.getByRole('link')).toHaveAttribute('href', '/borrow');
  });

  it('shows the lender role strip with the demo-pool bracket', async () => {
    await renderDoors(BOTH_OFF);
    for (const role of ['LPs', 'Credit vehicle', 'NBFC', 'Borrower']) {
      expect(lenderDoor().getByText(role)).toBeInTheDocument();
    }
    expect(
      lenderDoor().getByText('DEMO POOL = NBFC + CREDIT VEHICLE IN ONE PROGRAM'),
    ).toBeInTheDocument();
  });

  it('marks the lender door NEXT with no link while the book flag is off', async () => {
    await renderDoors(BOTH_OFF);
    expect(lenderDoor().getByText('NEXT')).toBeInTheDocument();
    expect(lenderDoor().queryByRole('link')).not.toBeInTheDocument();
  });

  it('links the lender door to the loan book when the book flag is on', async () => {
    await renderDoors({ book: true, verify: false });
    expect(lenderDoor().getByRole('link', { name: 'See the loan book' })).toBeInTheDocument();
    expect(lenderDoor().queryByText('NEXT')).not.toBeInTheDocument();
  });
});

describe('FinalCta', () => {
  beforeEach(async () => {
    hoisted.deps = (await world()).deps;
  });

  it('closes with a CTA to /borrow, a risk reversal and the lender ask', async () => {
    await renderWithRouter(<FinalCta ctaDisabledReason={null} />);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'See it run, end to end' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /run the live demo/i })).toHaveAttribute(
      'href',
      '/borrow',
    );
    expect(screen.getByText(/devnet only/i)).toBeInTheDocument();
    expect(screen.getByText(/design partners/i)).toBeInTheDocument();
  });

  it('disables the CTA with the reason when the demo is unavailable', async () => {
    await renderWithRouter(<FinalCta ctaDisabledReason="Gateway unreachable." />);
    expect(await screen.findByRole('button', { name: /run the live demo/i })).toBeDisabled();
    expect(screen.getByText('Gateway unreachable.')).toBeInTheDocument();
  });
});
