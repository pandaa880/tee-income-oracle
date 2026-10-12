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
import { Pilot } from './pilot.tsx';
import { FunderChecks } from './funder-checks.tsx';
import type { WorldOptions } from '../../test-support/world.ts';

const GITHUB = 'https://github.com/pandaa880/tee-income-oracle';
const PILOT_REQUEST = `${GITHUB}/issues/new?title=Pilot%20request%3A%20%3Corganisation%3E`;
const BOTH_OFF = { book: false, verify: false };

async function renderHome(options: WorldOptions = {}) {
  hoisted.deps = (await world(options)).deps;
  await renderWithRouter(<HomePage />);
  await screen.findByRole('heading', { level: 1 });
}

describe('HomePage', () => {
  it('leads with the receipts promise', async () => {
    await renderHome();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Every loan decision, with receipts. No bank statement attached.',
    );
  });

  it('lays the sections out in order, the pilot reachable by its anchor', async () => {
    await renderHome();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'What a funder can check on every loan',
      'From consent to loan in four steps',
      'Try the borrower flow',
      'Built for NBFCs and the credit vehicles that fund them',
      'Explore a pilot',
    ]);
    expect(document.getElementById('pilot')).toContainElement(
      screen.getByRole('heading', { level: 2, name: 'Explore a pilot' }),
    );
  });

  it('borrows no outside slogan', async () => {
    await renderHome();
    expect(document.body).not.toHaveTextContent(/superteam|not just lending|plug into/i);
  });

  it('calls the rules the pool’s eligibility criteria, never the lender’s', async () => {
    await renderHome();
    expect(document.body).not.toHaveTextContent(/lender['’]s (own )?(rules|policy)/i);
  });

  it('offers the devnet demo as a link to /borrow, with the honest line under it', async () => {
    await renderHome();
    const cta = screen.getAllByRole('link', { name: /run the devnet demo/i })[0];
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
    const ctas = await screen.findAllByRole('button', { name: /run the devnet demo/i });
    expect(ctas).toHaveLength(2);
    for (const cta of ctas) expect(cta).toBeDisabled();
    expect(screen.queryByRole('link', { name: /run the devnet demo/i })).not.toBeInTheDocument();
  });
});

describe('Hero', () => {
  it('links the primary CTA to /borrow when the demo is available', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<Hero ctaDisabledReason={null} />);
    expect(await screen.findByRole('link', { name: 'Run the devnet demo' })).toHaveAttribute(
      'href',
      '/borrow',
    );
  });

  it('offers a pilot next to the demo, as a jump to the pilot section', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<Hero ctaDisabledReason={null} />);
    expect(await screen.findByRole('link', { name: 'Explore a pilot' })).toHaveAttribute(
      'href',
      '#pilot',
    );
  });

  it('says the funder sets the criteria the enclave runs', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<Hero ctaDisabledReason={null} />);
    expect(
      await screen.findByText(/the funder sets the pool’s eligibility criteria/i),
    ).toBeInTheDocument();
  });

  it('says who never sees the statement, and never claims to prove income', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<Hero ctaDisabledReason={null} />);
    expect(
      await screen.findByText(
        'Only the enclave, in AWS Mumbai, decrypts the statement. The gateway, the lender, its funder and we never see it.',
      ),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(
      /prove (it|income|real income)|no one, including us/i,
    );
  });

  it('shows an example receipt, labelled as an example, with the statement not attached', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<Hero ctaDisabledReason={null} />);
    const receipt = within(await screen.findByRole('figure', { name: 'Example receipt' }));
    expect(receipt.getByText('EXAMPLE · DEVNET')).toBeInTheDocument();
    expect(receipt.getByText('81112a23…932e1c')).toBeInTheDocument();
    expect(receipt.getByText('not attached')).toBeInTheDocument();
    // An example makes no live claim: registration is only ever shown from the registry read.
    expect(receipt.queryByText(/registered/i)).not.toBeInTheDocument();
  });

  it('replaces the link with a disabled button and shows the reason', async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<Hero ctaDisabledReason="The enclave build was revoked." />);
    expect(await screen.findByRole('button', { name: 'Run the devnet demo' })).toBeDisabled();
    expect(screen.getByText('The enclave build was revoked.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Run the devnet demo' })).not.toBeInTheDocument();
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
    steps.forEach((step, i) =>
      expect(step).toHaveTextContent(`${String(i + 1).padStart(2, '0')}${starts[i]}.`),
    );
  });

  it('draws where the data travels, naming what each place sees', async () => {
    const figure = await screen.findByRole('img');
    expect(figure).toHaveAccessibleName(/Gateway: relays, can’t read/);
    expect(figure).toHaveAccessibleName(/Enclave: plaintext only here/);
    expect(screen.getByText(/your browser sees only the consent\./i)).toBeInTheDocument();
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

describe('FunderChecks', () => {
  beforeEach(async () => {
    hoisted.deps = (await world()).deps;
    await renderWithRouter(<FunderChecks />);
    await screen.findByRole('heading', { name: 'What a funder can check on every loan' });
  });

  it('lists what a funder can check per loan, with an honest status on each', async () => {
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.querySelector('[data-tone]')?.textContent)).toEqual([
      'CHECKABLE NOW',
      'CHECKABLE NOW',
      'CHECKABLE NOW',
      'NOT YET',
      'NEXT',
      'NEXT',
    ]);
    expect(rows[4]).toHaveTextContent(/matches a loan on the NBFC's tape/i);
    expect(rows[5]).toHaveTextContent(/paid out and is being repaid/i);
  });

  it('sets the receipt against today’s self-reported tape, and the tier apart from a score', async () => {
    expect(screen.getByText(/scores the NBFC reported itself/i)).toBeInTheDocument();
    expect(screen.getByText(/it isn’t a score/i)).toBeInTheDocument();
    expect(screen.getByText(/whether the criteria predict repayment/i)).toBeInTheDocument();
  });
});

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

  it('tells each side its own story', async () => {
    await renderDoors(BOTH_OFF);
    expect(
      screen.getByText(
        'Years of real income, no credit file? Show a lender a tier computed from your statement, not the statement.',
      ),
    ).toBeInTheDocument();
    expect(
      lenderDoor().getByText(/each funded loan’s receipt without sharing statements/),
    ).toBeInTheDocument();
    expect(
      lenderDoor().getByText(/the funder sets the eligibility criteria every loan must pass/i),
    ).toBeInTheDocument();
  });

  it('marks the lender door NEXT with no link while the book flag is off', async () => {
    await renderDoors(BOTH_OFF);
    expect(lenderDoor().getByText('NEXT')).toBeInTheDocument();
    expect(lenderDoor().getByText(/every loan with its receipt/i)).toBeInTheDocument();
    expect(lenderDoor().queryByRole('link')).not.toBeInTheDocument();
  });

  it('links the lender door to the loan book when the book flag is on', async () => {
    await renderDoors({ book: true, verify: false });
    expect(lenderDoor().getByRole('link', { name: 'See the loan book' })).toHaveAttribute(
      'href',
      '/book?pool=0',
    );
    expect(lenderDoor().queryByText('NEXT')).not.toBeInTheDocument();
  });
});

describe('Pilot', () => {
  beforeEach(async () => {
    hoisted.deps = (await world()).deps;
  });

  it('says what a pilot tests and where to ask for one', async () => {
    await renderWithRouter(<Pilot ctaDisabledReason={null} />);
    const heading = await screen.findByRole('heading', { level: 2, name: 'Explore a pilot' });
    const section = within(heading.closest('section') as HTMLElement);
    const tests = section.getAllByRole('listitem');
    expect(tests).toHaveLength(3);
    expect(tests[0]).toHaveTextContent(/your pool’s eligibility criteria, hash-committed/i);
    expect(tests[0]).toHaveTextContent(/your originator as the FIU/i);
    expect(tests[1]).toHaveTextContent(/no statements exchanged/i);
    expect(tests[2]).toHaveTextContent(/trust-based checks on a loan tape/i);
    const request = section.getByRole('link', { name: /request a pilot/i });
    expect(request).toHaveAttribute('href', PILOT_REQUEST);
    expect(request).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('keeps the demo one click away, with the risk reversal', async () => {
    await renderWithRouter(<Pilot ctaDisabledReason={null} />);
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Or see it run first' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /run the devnet demo/i })).toHaveAttribute(
      'href',
      '/borrow',
    );
    expect(screen.getByText(/devnet only/i)).toBeInTheDocument();
  });

  it('disables the demo CTA with the reason when the demo is unavailable', async () => {
    await renderWithRouter(<Pilot ctaDisabledReason="Gateway unreachable." />);
    expect(await screen.findByRole('button', { name: /run the devnet demo/i })).toBeDisabled();
    expect(screen.getByText('Gateway unreachable.')).toBeInTheDocument();
  });
});
