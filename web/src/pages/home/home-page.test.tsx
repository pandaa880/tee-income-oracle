import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../app/deps.ts';
import { renderWithRouter } from '../../test-support/render.tsx';
import { world } from '../../test-support/world.ts';
import type { WorldOptions } from '../../test-support/world.ts';

const hoisted = vi.hoisted(() => ({ deps: undefined as Deps | undefined }));
vi.mock('../../app/deps.ts', () => ({
  realDeps: () => {
    if (hoisted.deps === undefined) throw new Error('test deps not set');
    return hoisted.deps;
  },
}));
import { GITHUB_URL, PILOT_REQUEST_URL, RELEASE } from '../../app/release.ts';
import { HomePage } from './home-page.tsx';

const BOTH_OFF = { book: false, verify: false };

const H = {
  problem: 'Funding an NBFC means trusting its spreadsheet.',
  solution: 'TIO puts the borrower’s bank between the NBFC and the funder.',
  compare: 'The only check the NBFC can’t write itself.',
  security: 'The bank statement is read in one place, then wiped.',
  status: 'Pre-pilot. The hard part is already live on devnet.',
  market: '₹2.2 lakh crore of NBFC loans were securitised in FY26.',
  vision: 'One receipt, every loan rail.',
  close: 'Fund the loans, not the spreadsheet.',
};

async function renderHome(options: WorldOptions = {}) {
  hoisted.deps = (await world(options)).deps;
  await renderWithRouter(<HomePage />);
  await screen.findByRole('heading', { level: 1 });
}

/** The section named by its h2 through `aria-labelledby`, so a broken wiring fails the lookup. */
function sectionElement(title: string): HTMLElement {
  return screen.getByRole('region', { name: title });
}

const STAGE = /LIVE|NEXT|PLANNED/;

/** Queries scoped to the section that holds the given h2. */
function sectionOf(title: string) {
  return within(sectionElement(title));
}

/** The smallest ancestor of `label` whose text also carries a status word, i.e. its row. */
function rowOf(label: RegExp, status: RegExp): HTMLElement {
  let node: HTMLElement | null = screen.getByText(label);
  while (node !== null && !status.test(node.textContent ?? '')) node = node.parentElement;
  if (node === null) throw new Error(`no ${String(status)} beside ${String(label)}`);
  return node;
}

describe('HomePage hero', () => {
  it('leads with proof-of-reserves for loan books as the only h1', async () => {
    await renderHome();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Proof-of-reserves for loan books.');
  });

  it('links the demo CTA to /borrow and the second CTA to #solution', async () => {
    await renderHome();
    expect(screen.getAllByRole('link', { name: /run the devnet demo/i })[0]).toHaveAttribute(
      'href',
      '/borrow',
    );
    expect(screen.getByRole('link', { name: 'See how a pool is checked' })).toHaveAttribute(
      'href',
      '#solution',
    );
  });

  it('disables the hero and close demo CTAs, with the reason, when the service is down', async () => {
    await renderHome({ revokedAt: 5n });
    const ctas = await screen.findAllByRole('button', { name: /run the devnet demo/i });
    expect(ctas).toHaveLength(2);
    for (const cta of ctas) expect(cta).toBeDisabled();
    expect(screen.queryByRole('link', { name: /run the devnet demo/i })).not.toBeInTheDocument();
    // The reason beside each disabled button is the status banner's own words.
    const reason = (await screen.findByRole('alert')).textContent;
    for (const cta of ctas) expect(cta.nextElementSibling).toHaveTextContent(reason ?? '');
  });

  it('says Live, in the positive tone, once the status read says live', async () => {
    await renderHome();
    await screen.findByText('Enclave build #0 registered on Solana');
    const hero = within(screen.getByRole('region', { name: 'Introduction' }));
    expect(hero.getByText('Live on Solana devnet')).toHaveAttribute('data-tone', 'positive');
  });

  it('makes no Live claim anywhere on the page when the service is down', async () => {
    await renderHome({ revokedAt: 5n });
    await screen.findByRole('alert');
    // The pool card's "LIVE ON DEVNET" stage chip stays: it is a roadmap stage, not a status claim.
    expect(screen.queryByText('Live on Solana devnet')).not.toBeInTheDocument();
    const hero = within(screen.getByRole('region', { name: 'Introduction' }));
    expect(hero.getByText('On Solana devnet')).toHaveAttribute('data-tone', 'neutral');
  });

  it('names the pool card by its simulated caption', async () => {
    await renderHome();
    expect(screen.getByRole('figure', { name: /simulated pool/i })).toBeInTheDocument();
  });

  it('labels the pool card simulated and marks every line with its stage', async () => {
    await renderHome();
    expect(screen.getByText(/simulated/i)).toBeInTheDocument();
    const receipt = rowOf(/loan is real/i, STAGE);
    expect(receipt).toHaveTextContent(/LIVE/);
    expect(receipt).not.toHaveTextContent(/NEXT|PLANNED/);
    expect(rowOf(/money was paid out/i, STAGE)).toHaveTextContent(/NEXT/);
    expect(rowOf(/EMIs were paid/i, STAGE)).toHaveTextContent(/PLANNED/);
    expect(rowOf(/doesn’t match/i, STAGE)).toHaveTextContent(/PLANNED/);
    expect(rowOf(/rule state/i, STAGE)).toHaveTextContent(/PLANNED/);
  });
});

describe('HomePage sections', () => {
  it('lays the sections out in order: problem, solution, compare, security, status, market, vision, close', async () => {
    await renderHome();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      H.problem,
      H.solution,
      H.compare,
      H.security,
      H.status,
      H.market,
      H.vision,
      H.close,
    ]);
  });

  it('gives the solution section the id the hero jumps to', async () => {
    await renderHome();
    expect(document.getElementById('solution')).toContainElement(
      screen.getByRole('heading', { level: 2, name: H.solution }),
    );
  });

  it('tells the four steps in order and says the NBFC writes the tape and the servicer report', async () => {
    await renderHome();
    const body = sectionElement(H.problem).textContent ?? '';
    const at = ['Day 0', 'Day 30', 'Month 6', 'Month 14'].map((s) => body.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at.toSorted((a, b) => a - b)).toEqual(at);
    expect(body).toMatch(/tape/i);
    expect(body).toMatch(/servicer report/i);
    expect(body).toMatch(/written by the NBFC|NBFC (itself )?(writes|wrote)/i);
  });

  it('marks the solution cards LIVE ON DEVNET, NEXT and PLANNED, one each', async () => {
    await renderHome();
    const solution = sectionOf(H.solution);
    for (const badge of ['LIVE ON DEVNET', 'NEXT', 'PLANNED']) {
      expect(solution.getAllByText(badge)).toHaveLength(1);
    }
  });

  it('compares TIO with three alternatives, with a blind-spots row and staged payout and EMI rows', async () => {
    await renderHome();
    const table = within(sectionOf(H.compare).getByRole('table'));
    for (const option of ['TIO', 'Sampling audit', 'Servicer report', 'Bureau scrub']) {
      expect(table.getByRole('columnheader', { name: option })).toBeInTheDocument();
    }
    expect(table.getByRole('row', { name: /blind spots/i })).toBeInTheDocument();
    expect(table.getByRole('row', { name: /paid out|payout/i })).toHaveTextContent(/\(next\)/i);
    expect(table.getByRole('row', { name: /EMI/i })).toHaveTextContent(/\(planned\)/i);
  });

  it('collapses the comparison to one ledger per option on phones, with the same stages', async () => {
    await renderHome();
    const options = sectionOf(H.compare).getAllByRole('heading', { level: 3 });
    expect(options.map((h) => h.textContent)).toEqual([
      'TIO',
      'Sampling audit',
      'Servicer report',
      'Bureau scrub',
    ]);
    const tioLedger = options[0]?.parentElement;
    expect(tioLedger).toHaveTextContent(/\(next\)/);
    expect(tioLedger).toHaveTextContent(/\(planned\)/);
  });

  it('keeps the four numbered security steps and the data-path drawing', async () => {
    await renderHome();
    const security = sectionOf(H.security);
    const steps = security.getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    ['Consent', 'Verify blind', 'Attest', 'Lend'].forEach((start, i) =>
      expect(steps[i]).toHaveTextContent(`${String(i + 1).padStart(2, '0')}${start}.`),
    );
    const figure = security.getByRole('img');
    expect(figure).toHaveAccessibleName(/Gateway: relays, can’t read/);
    expect(figure).toHaveAccessibleName(/Enclave: plaintext only here/);
  });

  it('lists COMPLETE, NEXT, PLANNED and NEEDS A PARTNER in the status checklist', async () => {
    await renderHome();
    const status = sectionOf(H.status);
    for (const state of ['COMPLETE', 'NEXT', 'PLANNED', 'NEEDS A PARTNER']) {
      expect(status.getAllByText(state).length).toBeGreaterThan(0);
    }
  });

  it('shows the corrected market heading and RBI line, cites ICRA and RBI ¶39–40, and never ₹2.5', async () => {
    await renderHome();
    const market = sectionOf(H.market);
    expect(
      market.getByText(
        'When loans are sold directly, RBI rules let a buyer check as few as a third of them one by one.',
      ),
    ).toBeInTheDocument();
    expect(market.getByText(/ICRA/)).toBeInTheDocument();
    expect(market.getByText(/¶39–40/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('₹2.5');
  });

  it('lists five rails in the vision section', async () => {
    await renderHome();
    expect(sectionOf(H.vision).getAllByRole('listitem')).toHaveLength(5);
  });
});

describe('HomePage status and proof', () => {
  it('shows the enclave build number only once the registry read confirms it', async () => {
    await renderHome();
    expect(await screen.findByText('Enclave build #0 registered on Solana')).toBeInTheDocument();
  });

  it('falls back to a number-free build item while the status is loading', async () => {
    await renderHome({ gateway: { info: () => new Promise<never>(() => {}) } });
    expect(screen.getByText('Enclave build registered on Solana')).toBeInTheDocument();
  });

  it('makes no registration claim when the registry says the build was revoked', async () => {
    await renderHome({ revokedAt: 5n });
    await screen.findByRole('alert');
    expect(screen.queryByText(/registered on solana/i)).not.toBeInTheDocument();
  });

  it('makes no build claim when the status read itself failed', async () => {
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

  it('keeps the checkable proof items, with their links, in the status section', async () => {
    await renderHome();
    await screen.findByText('Enclave build #0 registered on Solana');
    const status = sectionOf(H.status);
    expect(status.getByText(`Reproducible build, ${RELEASE}`)).toBeInTheDocument();
    expect(status.getByRole('link', { name: 'Open source' })).toHaveAttribute('href', GITHUB_URL);
    expect(status.getByText('Live on Solana devnet')).toBeInTheDocument();
  });

  it('shows the verify item only with the verify flag', async () => {
    await renderHome({ features: { book: false, verify: true } });
    expect(sectionOf(H.status).getByText(/verify any tier yourself/i)).toBeInTheDocument();
  });

  it('shows no verify item and no gated link while the flags are off', async () => {
    await renderHome({ features: BOTH_OFF });
    expect(screen.queryByText(/verify any tier yourself/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /loan book|verify any tier/i }),
    ).not.toBeInTheDocument();
  });

  it('links the loan book from the status section only with the book flag', async () => {
    await renderHome({ features: { book: true, verify: false } });
    expect(sectionOf(H.status).getByRole('link', { name: /see the loan book/i })).toHaveAttribute(
      'href',
      '/book?pool=0',
    );
  });
});

describe('HomePage close and whole-page rules', () => {
  it('asks for a pilot with the pilot URL, in a new tab, without opener or referrer', async () => {
    await renderHome();
    const link = sectionOf(H.close).getByRole('link', { name: /request a pilot/i });
    expect(link).toHaveAttribute('href', PILOT_REQUEST_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    // On the inverted band the default --ring is under 3:1; the ring takes the band's paper.
    expect(link).toHaveClass('focus-visible:outline-background');
  });

  it('keeps the demo one click away from the close, with the devnet-only line', async () => {
    await renderHome();
    const close = sectionOf(H.close);
    expect(close.getByRole('link', { name: /run the devnet demo/i })).toHaveAttribute(
      'href',
      '/borrow',
    );
    expect(close.getByText(/^Devnet only/)).toBeInTheDocument();
  });

  it('borrows no outside slogan and never claims to prove income', async () => {
    await renderHome();
    expect(document.body).not.toHaveTextContent(/superteam|not just lending|plug into/i);
    expect(document.body).not.toHaveTextContent(
      /prove (it|income|real income)|no one, including us/i,
    );
  });

  it('leaves no placeholder tokens such as [YOUR PRICE] anywhere on the page', async () => {
    await renderHome();
    expect(document.body.textContent).not.toMatch(/\[[^\]]+\]/);
  });

  it('keeps the full-width hero and close bands inside the main landmark', async () => {
    await renderHome();
    const main = screen.getByRole('main');
    expect(main).toContainElement(screen.getByRole('heading', { level: 1 }));
    expect(main).toContainElement(screen.getByRole('heading', { level: 2, name: H.close }));
  });

  it('calls the rules the pool’s eligibility criteria, never the lender’s', async () => {
    await renderHome();
    expect(document.body).toHaveTextContent(/the pool’s eligibility criteria/i);
    expect(document.body).not.toHaveTextContent(/lender['’]s (own )?(rules|policy)/i);
  });
});
