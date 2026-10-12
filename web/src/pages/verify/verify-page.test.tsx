import { act, fireEvent, screen, within } from '@testing-library/react';
import { attestationAddress as attestationPda } from '@tio/oracle-client/attest';
import { CHECKS } from '@tio/verifier/report';
import { describe, expect, it, vi } from 'vitest';
import { GITHUB_URL, RELEASE } from '../../app/release.ts';
import type { Deps } from '../../app/deps.ts';
import { exampleWallets } from '../../domain/example-wallets.ts';
import { CHECK_EXPLANATIONS } from '../../domain/verify-view.ts';
import { explorerAddressUrl } from '../../domain/explorer.ts';
import { formatUnixDate, formatUnixDateTime, shortAddress, shortHex } from '../../domain/format.ts';
import { ADMIN, CREDENTIAL, SCHEMA } from '../../test-support/fixtures.ts';
import { ledgerValue } from '../../test-support/ledger.ts';
import { renderApp } from '../../test-support/render.tsx';
import { verifiedOf, world, type WorldOptions } from '../../test-support/world.ts';

const hoisted = vi.hoisted(() => ({ deps: undefined as Deps | undefined }));
vi.mock('../../app/deps.ts', () => ({
  realDeps: () => {
    if (hoisted.deps === undefined) throw new Error('test deps not set');
    return hoisted.deps;
  },
}));

// The real verifier runs behind these pages (P-384 chain, COSE, image id) over archived document 1.
vi.setConfig({ testTimeout: 30_000 });
const SLOW = { timeout: 20_000 };
const FEATURES = { book: false, verify: true };
const REVOKED_AT = 1_790_000_100n;

/** A world whose wallet holds an attestation for build 1, rendered at `/verify?wallet=<wallet>`. */
async function openWallet(
  options: WorldOptions = {},
  query = (wallet: string) => `?wallet=${wallet}`,
) {
  const w = await world({ verify: { docId: 1 }, features: FEATURES, ...options });
  hoisted.deps = w.deps;
  const app = await renderApp(`/verify${query(w.wallet)}`);
  return { ...w, ...app };
}

const checksHeading = (name: string) => screen.findByRole('heading', { level: 2, name }, SLOW);
const hrefs = () => screen.getAllByRole('link').map((a) => a.getAttribute('href'));
const rowOf = (title: string) => {
  const row = screen.getByText(title).closest('li');
  if (row === null) throw new Error(`no list row around "${title}"`);
  return row;
};

describe('VerifyPage without a wallet', () => {
  it('explains the page: heading and intro', async () => {
    await openWallet({}, () => '');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check any tier yourself' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^Paste a wallet\. This page reads Solana directly from your browser/),
    ).toBeInTheDocument();
  });

  it('offers a Borrower wallet box and a Check button, empty', async () => {
    await openWallet({}, () => '');
    expect(await screen.findByRole('textbox', { name: 'Borrower wallet' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Check' })).toBeInTheDocument();
  });

  it('shows no checks card and runs no verification', async () => {
    const w = await openWallet({}, () => '');
    await screen.findByRole('textbox', { name: 'Borrower wallet' });
    expect(
      screen.queryByRole('heading', { level: 2, name: /checks pass/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/reading the attestation/i)).not.toBeInTheDocument();
    expect(w.queryClient.getQueryCache().findAll({ queryKey: ['verify'] })).toHaveLength(0);
    expect(w.chain.rawAccounts).not.toHaveBeenCalled();
  });

  it('shows who signed it: the registered builds, one ACTIVE and one REVOKED', async () => {
    await openWallet({}, () => '');
    expect(await screen.findByText('Who signed it: registered enclave builds')).toBeInTheDocument();
    expect(await screen.findByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('REVOKED')).toBeInTheDocument();
    expect(screen.getByText(/attester 0xb6dd…574c/)).toBeInTheDocument();
    expect(screen.getByText(/attester 0xc39b…052b/)).toBeInTheDocument();
  });

  it('names both builds by number in the aside', async () => {
    await openWallet({}, () => '');
    expect(await screen.findByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#0')).toBeInTheDocument();
  });

  it('offers the devnet example wallets as links, none marked current yet', async () => {
    await openWallet({}, () => '');
    const nav = await screen.findByRole('navigation', { name: 'Example wallets' });
    expect(within(nav).getByText(/no wallet handy\?/i)).toBeInTheDocument();
    const examples = exampleWallets('devnet');
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(within(nav).getByRole('link', { name: example.label })).toHaveAttribute(
        'href',
        `/verify?wallet=${example.wallet}`,
      );
    }
    expect(within(nav).queryByRole('link', { current: 'page' })).not.toBeInTheDocument();
  });

  it('runs the check for an example wallet when its chip is clicked', async () => {
    const w = await openWallet({}, () => '');
    const [example] = exampleWallets('devnet');
    if (example === undefined) throw new Error('no example wallet');
    fireEvent.click(await screen.findByRole('link', { name: example.label }));
    await vi.waitFor(() =>
      expect(w.router.state.location.search).toMatchObject({ wallet: example.wallet }),
    );
    // The check ran for that wallet: its attestation PDA was read. The fake chain holds no
    // attestation for it, so the page reports that.
    expect(await screen.findByText('No tier for this wallet', undefined, SLOW)).toBeInTheDocument();
    const read = vi.mocked(w.chain.rawAccounts).mock.calls.flatMap(([keys]) => keys);
    expect(read).toContain(await attestationPda(CREDENTIAL, SCHEMA, example.wallet));
    expect(screen.getByRole('link', { name: example.label })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('VerifyPage wallet form', () => {
  it('is prefilled from ?wallet=', async () => {
    const w = await openWallet({ attestation: false });
    expect(await screen.findByRole('textbox', { name: 'Borrower wallet' })).toHaveValue(w.wallet);
  });

  it('treats a blank box as no wallet: the URL loses its wallet and no error shows', async () => {
    const w = await openWallet({ attestation: false });
    const box = await screen.findByRole('textbox', { name: 'Borrower wallet' });
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await vi.waitFor(() => expect(w.router.state.location.search).toEqual({}));
    expect(screen.queryByText('Not a Solana address')).not.toBeInTheDocument();
  });

  it('treats ?wallet= with nothing after it as no wallet', async () => {
    await openWallet({}, () => '?wallet=');
    await screen.findByRole('textbox', { name: 'Borrower wallet' });
    expect(screen.queryByText('Not a Solana address')).not.toBeInTheDocument();
  });

  it('navigates to /verify?wallet=<text> when Check is pressed', async () => {
    const w = await openWallet({ attestation: false }, () => '');
    const box = await screen.findByRole('textbox', { name: 'Borrower wallet' });
    fireEvent.change(box, { target: { value: ADMIN } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await vi.waitFor(() => expect(w.router.state.location.search).toMatchObject({ wallet: ADMIN }));
    expect(w.router.state.location.pathname).toBe('/verify');
  });
});

describe('VerifyPage with an invalid wallet', () => {
  it('says "Not a Solana address" next to the box', async () => {
    await openWallet({}, () => '?wallet=junk');
    const box = await screen.findByRole('textbox', { name: 'Borrower wallet' });
    expect(await screen.findByText('Not a Solana address')).toBeInTheDocument();
    expect(box).toHaveAccessibleDescription(/not a solana address/i);
  });

  it('keeps what was typed in the box', async () => {
    await openWallet({}, () => '?wallet=junk');
    expect(await screen.findByRole('textbox', { name: 'Borrower wallet' })).toHaveValue('junk');
  });

  it('runs no verification: no query, no chain read', async () => {
    const w = await openWallet({}, () => '?wallet=junk');
    await screen.findByText('Not a Solana address');
    expect(w.queryClient.getQueryCache().findAll({ queryKey: ['verify'] })).toHaveLength(0);
    expect(w.chain.rawAccounts).not.toHaveBeenCalled();
  });

  it('shows no checks card', async () => {
    await openWallet({}, () => '?wallet=junk');
    await screen.findByText('Not a Solana address');
    expect(
      screen.queryByRole('heading', { level: 2, name: /checks pass/i }),
    ).not.toBeInTheDocument();
  });
});

describe('VerifyPage while reading', () => {
  it('says what it is doing, and marks the region busy', async () => {
    const w = await world({ verify: { docId: 1 }, features: FEATURES });
    vi.mocked(w.chain.rawAccounts).mockImplementation(() => new Promise(() => undefined));
    hoisted.deps = w.deps;
    await renderApp(`/verify?wallet=${w.wallet}`);
    const text = await screen.findByText('Reading the attestation and running the checks…');
    expect(text.closest('[aria-busy="true"]')).not.toBeNull();
    expect(
      screen.queryByRole('heading', { level: 2, name: /checks pass/i }),
    ).not.toBeInTheDocument();
  });
});

describe('VerifyPage with a passing tier', () => {
  it('headlines the build and says PASS', async () => {
    await openWallet();
    expect(await checksHeading('Build #1 · 7 of 7 checks pass')).toBeInTheDocument();
    expect(screen.getByText('PASS')).toBeInTheDocument();
    expect(screen.queryByText('FAIL')).not.toBeInTheDocument();
  });

  it('lists the seven checks by title with their explanation and a pass mark each', async () => {
    await openWallet();
    await checksHeading('Build #1 · 7 of 7 checks pass');
    expect(screen.getAllByLabelText('pass')).toHaveLength(7);
    expect(screen.queryAllByLabelText('fail')).toHaveLength(0);
    for (const { id, title } of CHECKS) {
      const row = rowOf(title);
      expect(within(row).getByLabelText('pass')).toBeInTheDocument();
      expect(row).toHaveTextContent(CHECK_EXPLANATIONS[id]);
    }
  });

  it('shows the details the verifier library gave, in the rows they belong to', async () => {
    await openWallet();
    await checksHeading('Build #1 · 7 of 7 checks pass');
    expect(rowOf('Entry is active')).toHaveTextContent('entry #1 active, kind 1');
    expect(rowOf('Image id matches the registry')).toHaveTextContent(
      'image id 7dd33d974511a825c871f267ebdc6b34fb9cdc2c63210e27a31a8c7cfb96daff',
    );
    expect(rowOf('Enclave key = on-chain attester')).toHaveTextContent(
      '0xb6dda6eed87322334ba37809bd451a852ae6574c',
    );
  });

  it('shows the attestation facts: address, signer, policy, dates, build', async () => {
    const w = await openWallet();
    await checksHeading('Build #1 · 7 of 7 checks pass');
    const { attestationAddress, issuedAt, expiry } = verifiedOf(w);
    expect(ledgerValue('Attestation')).toContain(shortAddress(attestationAddress));
    expect(ledgerValue('Written by')).toBe('oracle signer ✓ (not a look-alike)');
    expect(ledgerValue('Policy')).toContain(shortHex('11'.repeat(32)));
    expect(ledgerValue('Issued · expires')).toContain(formatUnixDate(issuedAt));
    expect(ledgerValue('Issued · expires')).toContain(formatUnixDate(expiry));
    expect(ledgerValue('Enclave build')).toBe('#1');
  });

  it('shows the tier letter', async () => {
    await openWallet();
    await checksHeading('Build #1 · 7 of 7 checks pass');
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('links the attestation address to the explorer', async () => {
    const w = await openWallet();
    await checksHeading('Build #1 · 7 of 7 checks pass');
    expect(hrefs()).toContain(explorerAddressUrl('devnet', verifiedOf(w).attestationAddress));
  });

  it('links the release tag, the archived attestation at this release, and the registry entry', async () => {
    const w = await openWallet();
    await checksHeading('Build #1 · 7 of 7 checks pass');
    expect(screen.getByRole('link', { name: /^Enclave source: release v0\.3\.0/ })).toHaveAttribute(
      'href',
      'https://github.com/pandaa880/tee-income-oracle/releases/tag/v0.3.0',
    );
    expect(screen.getByRole('link', { name: /^Archived attestation/ })).toHaveAttribute(
      'href',
      `${GITHUB_URL}/blob/${RELEASE}/deployments/devnet/attestation-1.hex`,
    );
    expect(screen.getByRole('link', { name: /^Registry entry/ })).toHaveAttribute(
      'href',
      explorerAddressUrl('devnet', verifiedOf(w).entryAddress),
    );
  });

  it('offers the same check in a terminal, with this wallet filled in', async () => {
    const w = await openWallet();
    await checksHeading('Build #1 · 7 of 7 checks pass');
    expect(screen.getByText(/^Prefer a terminal\? Same library:/)).toBeInTheDocument();
    const command = `pnpm --filter @tio/verifier verify -- ${w.wallet} --cluster devnet`;
    expect(
      screen.getByText((_, el) => el?.tagName === 'CODE' && el.textContent === command),
    ).toBeInTheDocument();
  });

  it('explains why the document is an archived one', async () => {
    await openWallet();
    await checksHeading('Build #1 · 7 of 7 checks pass');
    expect(screen.getByText(/^Why an archived document:/)).toBeInTheDocument();
  });

  it('keeps the registered builds aside next to the result', async () => {
    await openWallet();
    await checksHeading('Build #1 · 7 of 7 checks pass');
    expect(screen.getByText('Who signed it: registered enclave builds')).toBeInTheDocument();
    expect(await screen.findByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('REVOKED')).toBeInTheDocument();
  });
});

describe('VerifyPage with a failing check', () => {
  it('says 6 of 7 and FAIL for a revoked entry', async () => {
    await openWallet({ verify: { docId: 1, entry: { revokedAt: REVOKED_AT } } });
    expect(await checksHeading('Build #1 · 6 of 7 checks pass')).toBeInTheDocument();
    expect(screen.getByText('FAIL')).toBeInTheDocument();
    expect(screen.queryByText('PASS')).not.toBeInTheDocument();
  });

  it('marks only the last row failed and gives its reason', async () => {
    await openWallet({ verify: { docId: 1, entry: { revokedAt: REVOKED_AT } } });
    await checksHeading('Build #1 · 6 of 7 checks pass');
    expect(screen.getAllByLabelText('fail')).toHaveLength(1);
    expect(screen.getAllByLabelText('pass')).toHaveLength(6);
    const row = rowOf('Entry is active');
    expect(within(row).getByLabelText('fail')).toBeInTheDocument();
    expect(row.textContent).toMatch(/revoked at/);
  });

  it('shows every failing row, not only the first', async () => {
    await openWallet({
      verify: { docId: 1, compose: 'wrong', entry: { revokedAt: REVOKED_AT } },
    });
    await checksHeading('Build #1 · 5 of 7 checks pass');
    expect(screen.getAllByLabelText('fail')).toHaveLength(2);
    expect(within(rowOf('Runs our published code')).getByLabelText('fail')).toBeInTheDocument();
    expect(within(rowOf('Entry is active')).getByLabelText('fail')).toBeInTheDocument();
  });
});

/** A 7/7 PASS on screen, then a re-read that fails with `rpc_busy`. */
async function passThenFail() {
  const w = await openWallet();
  await checksHeading('Build #1 · 7 of 7 checks pass');
  const readAt = w.queryClient.getQueryCache().findAll({ queryKey: ['verify'] })[0]
    ?.state.dataUpdatedAt;
  if (readAt === undefined) throw new Error('no verification read');
  vi.mocked(w.chain.rawAccounts).mockResolvedValue({ ok: false, error: { code: 'rpc_busy' } });
  // TanStack notifies observers on a timer tick: wait one, inside act, before asserting.
  await act(async () => {
    await w.queryClient.refetchQueries();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { ...w, readAt };
}

describe('VerifyPage when a re-check fails after a result', () => {
  it('keeps the result on screen but says the re-check failed and when the checks ran', async () => {
    const { readAt, queryClient } = await passThenFail();
    expect(queryClient.getQueryCache().findAll({ queryKey: ['verify'] })[0]?.state.status).toBe(
      'error',
    );
    const banner = screen.getByRole('status', { name: /couldn.t re-check this wallet/i });
    expect(banner).toHaveTextContent(/network busy/i);
    expect(banner).toHaveTextContent(formatUnixDateTime(BigInt(Math.floor(readAt / 1000))));
    expect(banner).toHaveTextContent(/the checks ran then/i);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Build #1 · 7 of 7 checks pass' }),
    ).toBeInTheDocument();
    expect(screen.getByText('PASS')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the warning once Try again verifies the wallet again', async () => {
    const w = await passThenFail();
    vi.mocked(w.chain.rawAccounts).mockImplementation(async (addresses) => ({
      ok: true,
      value: addresses.map((a) => w.raw.get(a) ?? null),
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await vi.waitFor(
      () =>
        expect(
          screen.queryByRole('status', { name: /couldn.t re-check this wallet/i }),
        ).not.toBeInTheDocument(),
      SLOW,
    );
    expect(screen.getByText('PASS')).toBeInTheDocument();
  });
});

describe('VerifyPage with an attestation another signer wrote', () => {
  it('fails although all seven checks pass, and says the signer is the reason', async () => {
    await openWallet({ verify: { docId: 1, signer: ADMIN } });
    expect(await checksHeading('Build #1 · 7 of 7 checks pass')).toBeInTheDocument();
    expect(screen.getByText('FAIL')).toBeInTheDocument();
    expect(screen.getByText(/was not written by the oracle's signer/)).toBeInTheDocument();
  });

  it('names the other signer under "Written by"', async () => {
    await openWallet({ verify: { docId: 1, signer: ADMIN } });
    await checksHeading('Build #1 · 7 of 7 checks pass');
    expect(ledgerValue('Written by')).toBe(
      `another signer ${shortAddress(ADMIN)} — not the oracle`,
    );
  });
});

describe('VerifyPage errors', () => {
  it('says "No tier for this wallet" for a wallet without an attestation, with no checks card', async () => {
    await openWallet({ attestation: false });
    expect(await screen.findByText('No tier for this wallet', undefined, SLOW)).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: /checks pass/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('FAIL')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('offers Retry when GitHub could not be reached, and Retry reads again', async () => {
    const w = await openWallet({ verify: { docId: 1, compose: 'unreachable' } });
    expect(
      await screen.findByText('GitHub could not be reached', undefined, SLOW),
    ).toBeInTheDocument();
    const before = vi.mocked(w.chain.rawAccounts).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(
      () => expect(vi.mocked(w.chain.rawAccounts).mock.calls.length).toBeGreaterThan(before),
      SLOW,
    );
  });

  it('keeps the RPC message for a busy RPC, with Retry', async () => {
    const w = await world({ verify: { docId: 1 }, features: FEATURES });
    vi.mocked(w.chain.rawAccounts).mockResolvedValue({
      ok: false,
      error: { code: 'rpc_busy' },
    });
    hoisted.deps = w.deps;
    await renderApp(`/verify?wallet=${w.wallet}`);
    expect(await screen.findByRole('button', { name: 'Retry' }, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Network busy')).toBeInTheDocument();
    expect(screen.queryByText('No tier for this wallet')).not.toBeInTheDocument();
  });

  it('offers Retry for a cancelled read too, so a cut-short check is never a dead end', async () => {
    const w = await world({ verify: { docId: 1 }, features: FEATURES });
    vi.mocked(w.chain.rawAccounts).mockResolvedValue({
      ok: false,
      error: { code: 'cancelled' },
    });
    hoisted.deps = w.deps;
    await renderApp(`/verify?wallet=${w.wallet}`);
    expect(await screen.findByRole('button', { name: 'Retry' }, SLOW)).toBeInTheDocument();
  });

  it('shows the attester the chain entry holds, not the deployment file, in the aside', async () => {
    // Build 1's entry gets an attester the file does not know; the aside must show that one.
    await openWallet({
      attestation: false,
      verify: { docId: 1, entry: { attester: new Uint8Array(20).fill(0xab) } },
    });
    await screen.findByText('No tier for this wallet', undefined, SLOW);
    expect(screen.getByText(/attester 0xabab…abab/)).toBeInTheDocument();
    expect(screen.queryByText(/attester 0xb6dd…574c/)).not.toBeInTheDocument();
  });

  it('re-runs the check for the same wallet when Check is pressed again after an error', async () => {
    const w = await openWallet({ attestation: false });
    await screen.findByText('No tier for this wallet', undefined, SLOW);
    const before = vi.mocked(w.chain.rawAccounts).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await vi.waitFor(
      () => expect(vi.mocked(w.chain.rawAccounts).mock.calls.length).toBeGreaterThan(before),
      SLOW,
    );
  });

  it('keeps the form usable after an error, so another wallet can be tried', async () => {
    await openWallet({ attestation: false });
    await screen.findByText('No tier for this wallet', undefined, SLOW);
    expect(screen.getByRole('textbox', { name: 'Borrower wallet' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Check' })).toBeEnabled();
  });
});
