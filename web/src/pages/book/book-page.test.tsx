import { getBase16Codec } from '@solana/kit';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { describe, expect, it, vi } from 'vitest';
import { POLICY_URL, PUBLISHED_POLICY_HASH } from '../../app/release.ts';
import type { Deps } from '../../app/deps.ts';
import { bookHealthLabel } from '../../domain/credential-copy.ts';
import { explorerAddressUrl } from '../../domain/explorer.ts';
import {
  formatAge,
  formatPercent,
  formatTokens,
  shortAddress,
  shortHex,
} from '../../domain/format.ts';
import { fail } from '../../test-support/fakes.ts';
import { renderApp } from '../../test-support/render.tsx';
import { world, type WorldOptions } from '../../test-support/world.ts';

const hoisted = vi.hoisted(() => ({ deps: undefined as Deps | undefined }));
vi.mock('../../app/deps.ts', () => ({
  realDeps: () => {
    if (hoisted.deps === undefined) throw new Error('test deps not set');
    return hoisted.deps;
  },
}));

// Odd limits so they do not collide with amounts elsewhere on the page.
const LIMITS = [7_000_000_000n, 3_500_000_000n, 1_250_000_000n];
const FEATURES = { book: true, verify: false };
const OLD_POLICY = new Uint8Array(32).fill(0x22);
const now = () => BigInt(Math.floor(Date.now() / 1000));

// Pool 0, newest first: fresh, stale, retired build, old policy, re-attested to tier B.
// 3,875 tokens outstanding against 6,125 in the vault: 38.75% utilization.
const POOL_0_LOANS: NonNullable<WorldOptions['bookLoans']> = [
  { amount: 2_000_000_000n, tier: 1 },
  {
    amount: 1_000_000_000n,
    tier: 2,
    attestation: { payload: { tier: 2, issuedAt: now() - 3_000_000n } },
  },
  {
    amount: 500_000_000n,
    tier: 3,
    attestation: { payload: { tier: 3, measurementId: 1 } },
  },
  { amount: 250_000_000n, tier: 1, attestation: { payload: { policyHash: OLD_POLICY } } },
  {
    amount: 125_000_000n,
    tier: 1,
    loanIssuedAt: now() - 90_000n,
    attestation: { payload: { tier: 2 } },
  },
];

async function prepare(options: WorldOptions = {}) {
  const w = await world({
    features: FEATURES,
    poolParams: { tierLimits: LIMITS },
    vault: { 0: 6_125_000_000n, 1: 9_000_000_000n },
    bookLoans: [...POOL_0_LOANS, { pool: 1, amount: 750_000_000n }],
    entries: { 1: { revokedAt: 5n } },
    ...options,
  });
  hoisted.deps = w.deps;
  return w;
}

async function open(options: WorldOptions = {}, path = '/book?pool=0') {
  const w = await prepare(options);
  const app = await renderApp(path);
  return { ...w, ...app };
}

const heading = (name: string) => screen.findByRole('heading', { name });

/** The nearest ancestor of a label that also holds its value (a KPI or ledger cell). */
function cellOf(label: string | RegExp): HTMLElement {
  const own = screen.getByText(label);
  for (let el = own.parentElement; el !== null; el = el.parentElement) {
    if ((el.textContent ?? '').length > (own.textContent ?? '').length) return el;
  }
  throw new Error('label has no value next to it');
}

function rowOf(borrower: string): HTMLElement {
  const row = screen
    .getAllByRole('row')
    .find((r) => (r.textContent ?? '').includes(shortAddress(borrower)));
  if (row === undefined) throw new Error(`no row for ${borrower}`);
  return row;
}

function borrowerAt(book: Awaited<ReturnType<typeof open>>['bookLoans'], i: number): string {
  const found = book[i];
  if (found === undefined) throw new Error('no such loan');
  return found.borrower;
}

describe('BookPage header', () => {
  it('is titled by the pool and explains the view', async () => {
    await open();
    expect(await heading('Pool 0 · loan book')).toHaveProperty('tagName', 'H1');
    expect(
      screen.getByText(/The view a credit vehicle gets of the loans it funds through an NBFC/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Read-only, straight from chain\./)).toBeInTheDocument();
  });

  it('shows the role strip with the demo-pool bracket', async () => {
    await open();
    expect(
      await screen.findByText('DEMO POOL = NBFC + CREDIT VEHICLE IN ONE PROGRAM'),
    ).toBeInTheDocument();
    expect(screen.getByText('Who funds whom · money flows left to right')).toBeInTheDocument();
  });

  it('has one tab per pool', async () => {
    await open();
    expect(await screen.findByRole('tab', { name: 'Pool 0' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Pool 1' })).toHaveAttribute('aria-selected', 'false');
  });

  it('falls back to pool 0 for a pool that does not exist', async () => {
    await open({}, '/book?pool=7');
    expect(await heading('Pool 0 · loan book')).toBeInTheDocument();
  });

  it('switches to the other pool in the URL and shows its loans', async () => {
    const w = await open();
    await screen.findByRole('table');
    const tab = await screen.findByRole('tab', { name: 'Pool 1' });
    fireEvent.mouseDown(tab, { button: 0 });
    await vi.waitFor(() => expect(tab).toHaveAttribute('aria-selected', 'true'));
    expect(w.router.state.location.search).toMatchObject({ pool: 1 });
    expect(await heading('Pool 1 · loan book')).toBeInTheDocument();
    const pool1Borrower = borrowerAt(w.bookLoans, 5);
    expect(await screen.findByText(shortAddress(pool1Borrower))).toBeInTheDocument();
    expect(screen.queryByText(shortAddress(borrowerAt(w.bookLoans, 0)))).not.toBeInTheDocument();
  });
});

describe('BookPage policy card', () => {
  it('shows the short policy hash with a link to the policy JSON', async () => {
    await open();
    expect(await screen.findByText(/Policy \(the funder['’]s rules\)/)).toBeInTheDocument();
    expect(screen.getByText(shortHex('11'.repeat(32)))).toBeInTheDocument();
    expect(screen.getByText(shortHex('11'.repeat(32)))).toHaveTextContent('11111111…111111');
    expect(screen.getByRole('link', { name: /policy JSON/i })).toHaveAttribute('href', POLICY_URL);
  });

  it('shows the tier limits and the three freshness rules', async () => {
    await open();
    await screen.findByText(/Policy \(the funder['’]s rules\)/);
    expect(cellOf('Tier limits')).toHaveTextContent('A 7,000 · B 3,500 · C 1,250');
    expect(screen.getByText('tier ≤ 30 days old')).toBeInTheDocument();
    expect(screen.getByText('statement ends ≤ 365 days before the tier')).toBeInTheDocument();
    expect(screen.getByText('statement covers ≥ 90 days')).toBeInTheDocument();
  });

  it('shows each approved build as a chip linking to its registry entry on the explorer', async () => {
    await open();
    await screen.findByText(/Policy \(the funder['’]s rules\)/);
    const [entry0] = await findEnclaveEntryPda({ measurementId: 0 });
    const [entry1] = await findEnclaveEntryPda({ measurementId: 1 });
    expect(screen.getByRole('link', { name: '#0' })).toHaveAttribute(
      'href',
      explorerAddressUrl('devnet', entry0),
    );
    expect(screen.getByRole('link', { name: '#1' })).toHaveAttribute(
      'href',
      explorerAddressUrl('devnet', entry1),
    );
  });
});

describe('BookPage KPIs and tier mix', () => {
  it('shows the principal outstanding, utilization, open loans and the vault', async () => {
    await open();
    await heading('Pool 0 · loan book');
    await screen.findByText('Principal outstanding');
    expect(cellOf('Principal outstanding')).toHaveTextContent(formatTokens(3_875_000_000n));
    expect(cellOf('Utilization')).toHaveTextContent(formatPercent(3875));
    expect(cellOf('Utilization')).toHaveTextContent('38.7%');
    expect(screen.getByText('outstanding ÷ (outstanding + vault)')).toBeInTheDocument();
    expect(cellOf('Open loans')).toHaveTextContent('5');
    expect(cellOf('In vault')).toHaveTextContent(formatTokens(6_125_000_000n));
  });

  it('shows the count and principal of each tier at borrow', async () => {
    await open();
    await heading('Pool 0 · loan book');
    expect(await screen.findByText('Tier mix by principal')).toBeInTheDocument();
    expect(screen.getByText(/A\s*·\s*3\s*·\s*2,375/)).toBeInTheDocument();
    expect(screen.getByText(/B\s*·\s*1\s*·\s*1,000/)).toBeInTheDocument();
    expect(screen.getByText(/C\s*·\s*1\s*·\s*500/)).toBeInTheDocument();
  });

  it('shows a dash for utilization when nothing is outstanding and the vault is empty', async () => {
    await open({ bookLoans: [], vault: { 0: 0n } });
    await screen.findByText('Utilization');
    expect(cellOf('Utilization')).toHaveTextContent('—');
  });
});

describe('BookPage loans table', () => {
  it('has the eight columns', async () => {
    await open();
    await screen.findByRole('table');
    for (const name of [
      'Borrower',
      'Tier',
      'Amount',
      'Out',
      'Tier age',
      'Build',
      'Credential',
      'Links',
    ]) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
  });

  it('lists the newest loan first', async () => {
    const w = await open();
    await screen.findByRole('table');
    const shown = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent ?? '');
    expect(shown).toHaveLength(5);
    shown.forEach((text, i) => expect(text).toContain(shortAddress(borrowerAt(w.bookLoans, i))));
  });

  it('shows borrower, tier at borrow, amount, time out, tier age and build of a fresh loan', async () => {
    const w = await open();
    await screen.findByRole('table');
    const row = within(rowOf(borrowerAt(w.bookLoans, 0)));
    expect(row.getByText(shortAddress(borrowerAt(w.bookLoans, 0)))).toBeInTheDocument();
    expect(row.getByText('A')).toBeInTheDocument();
    expect(row.getByText(formatTokens(2_000_000_000n))).toBeInTheDocument();
    expect(row.getByText(formatAge(3600n))).toBeInTheDocument();
    expect(row.getByText(formatAge(1000n))).toBeInTheDocument();
    expect(row.getByText('#0')).toBeInTheDocument();
  });

  it.each([
    [0, 'valid'],
    [1, 'stale'],
    [2, 'enclave_revoked'],
    [3, 'policy_mismatch'],
  ] as const)('badges loan %i as %s', async (index, status) => {
    const w = await open();
    await screen.findByRole('table');
    const row = within(rowOf(borrowerAt(w.bookLoans, index)));
    expect(row.getByText(bookHealthLabel(status))).toBeInTheDocument();
  });

  it('spells the four badges out', async () => {
    await open();
    await screen.findByRole('table');
    for (const label of [
      'FRESH',
      'STALE · RE-ATTEST',
      'BUILD RETIRED · RE-ATTEST',
      'OLD POLICY · RE-ATTEST',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('shows the age of the tier and the build of a stale loan', async () => {
    const w = await open();
    await screen.findByRole('table');
    const row = within(rowOf(borrowerAt(w.bookLoans, 1)));
    expect(row.getByText('B')).toBeInTheDocument();
    expect(row.getByText(formatAge(3_000_000n))).toBeInTheDocument();
    expect(row.getByText('#0')).toBeInTheDocument();
  });

  it('shows the build of a retired-build loan', async () => {
    const w = await open();
    await screen.findByRole('table');
    expect(within(rowOf(borrowerAt(w.bookLoans, 2))).getByText('#1')).toBeInTheDocument();
  });

  it('links each loan and its attestation to the explorer', async () => {
    const w = await open();
    await screen.findByRole('table');
    const first = w.bookLoans[0];
    if (first === undefined) throw new Error('no loan');
    const row = within(rowOf(first.borrower));
    expect(row.getByRole('link', { name: /^Loan/ })).toHaveAttribute(
      'href',
      explorerAddressUrl('devnet', first.loanAddress),
    );
    expect(row.getByRole('link', { name: /^Attestation/ })).toHaveAttribute(
      'href',
      explorerAddressUrl('devnet', first.attestationAddress),
    );
  });

  it('notes a re-attestation with the tier now, and keeps the tier at borrow', async () => {
    const w = await open();
    await screen.findByRole('table');
    const row = within(rowOf(borrowerAt(w.bookLoans, 4)));
    expect(row.getByText(/re-attested since borrow · now B/)).toBeInTheDocument();
    expect(row.getByText('A')).toBeInTheDocument();
    for (const i of [0, 1, 2, 3]) {
      expect(
        within(rowOf(borrowerAt(w.bookLoans, i))).queryByText(/re-attested since borrow/),
      ).not.toBeInTheDocument();
    }
  });

  it('shows dashes and NO TIER for a borrower without an attestation', async () => {
    const w = await open({ bookLoans: [{ attestation: false }] });
    await screen.findByRole('table');
    const row = within(rowOf(borrowerAt(w.bookLoans, 0)));
    expect(row.getByText('NO TIER')).toBeInTheDocument();
    expect(row.getAllByText('—')).toHaveLength(2);
  });
});

describe('BookPage empty pool', () => {
  it('says there are no open loans and offers to borrow', async () => {
    await open({ bookLoans: [] });
    expect(await screen.findByText('No open loans in this pool yet.')).toBeInTheDocument();
    expect(screen.getByText('No open loans')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Borrow from this pool' })).toHaveAttribute(
      'href',
      '/borrow',
    );
    expect(cellOf('Open loans')).toHaveTextContent('0');
  });

  it('shows 0.0% utilization for an empty book with money in the vault', async () => {
    await open({ bookLoans: [] });
    await screen.findByText('Utilization');
    expect(cellOf('Utilization')).toHaveTextContent('0.0%');
  });
});

describe('BookPage roadmap and footnote', () => {
  it('flags the outcomes panel as roadmap', async () => {
    await open();
    expect(await heading('Outcomes per tier')).toBeInTheDocument();
    expect(screen.getByText('ROADMAP')).toBeInTheDocument();
    expect(screen.getByText(/Coming with due dates and defaults/i)).toBeInTheDocument();
  });

  it('explains that a retired build is monitoring, not a bug', async () => {
    await open();
    expect(await screen.findByText(/monitoring, not a bug/)).toBeInTheDocument();
  });
});

describe('BookPage failures', () => {
  it('shows the error card when the loans cannot be read, and re-reads on retry', async () => {
    const w = await prepare();
    vi.mocked(w.chain.poolLoans).mockResolvedValueOnce(fail({ code: 'rpc_busy' }));
    await renderApp('/book?pool=0');
    expect(await screen.findByRole('alert')).toHaveTextContent('Network busy');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(w.chain.poolLoans).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('BookPage review fixes', () => {
  it('keeps the last good book on screen when a background re-read fails', async () => {
    const w = await prepare();
    const { queryClient } = await renderApp('/book?pool=0');
    await screen.findByRole('table');
    vi.mocked(w.chain.poolLoans).mockResolvedValue(fail({ code: 'rpc_busy' }));
    // TanStack notifies observers on a timer tick: wait one, inside act, so the failed re-read
    // has rendered before asserting what stays on screen.
    await act(async () => {
      await queryClient.refetchQueries();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const [book] = queryClient.getQueryCache().findAll({ queryKey: ['book'] });
    expect(book?.state.status).toBe('error');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says when the pool pins a policy other than the published default', async () => {
    await open();
    expect(await screen.findByText('not the published default')).toBeInTheDocument();
  });

  it('says when the pool pins the published default policy', async () => {
    const published = getBase16Codec().encode(PUBLISHED_POLICY_HASH);
    await open({ bookLoans: [], poolParams: { tierLimits: LIMITS, policyHash: published } });
    expect(await screen.findByText('published default')).toBeInTheDocument();
    expect(screen.queryByText('not the published default')).not.toBeInTheDocument();
  });

  it('names the table and each row link by its borrower', async () => {
    const w = await open();
    const first = w.bookLoans[0];
    if (first === undefined) throw new Error('no loan');
    expect(await screen.findByRole('table', { name: 'Loans in this pool' })).toBeInTheDocument();
    const short = shortAddress(first.borrower);
    expect(screen.getByRole('link', { name: `Loan of ${short}` })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `Attestation of ${short}` })).toBeInTheDocument();
  });

  it('titles each section with an h2 under the page h1', async () => {
    await open();
    for (const name of [
      /Policy \(the funder['’]s rules\)/,
      'Tier mix by principal',
      'Loans in this pool',
      'Outcomes per tier',
    ]) {
      expect(await screen.findByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
  });

  it('reads the tier mix bar out with the same percent format as the KPIs', async () => {
    await open();
    // Tier A: 2,375 of 3,875 = 6129 bps → "61.2%" (formatPercent floors to one decimal).
    expect(await screen.findByRole('img', { name: /tier A 61\.2%,/ })).toBeInTheDocument();
  });
});
