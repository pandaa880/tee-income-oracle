import { renderHook, waitFor } from '@testing-library/react';
import type { Address } from '@solana/kit';
import { findLoanPda, findVaultPda } from '@tio/demo-pool-client';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress } from '@tio/oracle-client/attest';
import { describe, expect, it, vi } from 'vitest';
import { fetchBook, useBook } from './use-book.ts';
import { fail, ok } from '../test-support/fakes.ts';
import { CREDENTIAL, OTHER, POOL_0, POOL_1, SCHEMA } from '../test-support/fixtures.ts';
import { queryWrapper } from '../test-support/query.tsx';
import { liveAttestation, world, type WorldOptions } from '../test-support/world.ts';

const signal = () => new AbortController().signal;
const byText = (a: string, b: string) => a.localeCompare(b);
const entryPda = async (measurementId: number): Promise<Address> =>
  (await findEnclaveEntryPda({ measurementId }))[0];

async function open(options: WorldOptions = {}) {
  const w = await world({ ...options });
  const [vault] = await findVaultPda({ pool: POOL_0 });
  const accountCalls = () => vi.mocked(w.deps.chain.accounts).mock.calls.map(([keys]) => keys);
  return { ...w, vault, accountCalls };
}

const THREE = [
  { amount: 3_000_000n },
  { amount: 2_000_000n, attestation: { payload: { measurementId: 1 } } },
  { amount: 1_000_000n, attestation: false as const },
];

describe('fetchBook', () => {
  it('reads the pool and vault, the loans, one attestation per borrower and each build once', async () => {
    const w = await open({ bookLoans: THREE, entries: { 1: {} } });
    const book = await fetchBook(w.deps, POOL_0, signal());

    expect(w.deps.chain.poolLoans).toHaveBeenCalledTimes(1);
    expect(vi.mocked(w.deps.chain.poolLoans).mock.calls[0]?.[0]).toBe(POOL_0);
    const [poolRead, attestationRead, entryRead, ...rest] = w.accountCalls();
    expect(rest).toEqual([]);
    expect(poolRead).toEqual([POOL_0, w.vault]);
    const expected = await Promise.all(
      w.bookLoans.map((l) => attestationAddress(CREDENTIAL, SCHEMA, l.borrower)),
    );
    expect(attestationRead).toHaveLength(3);
    expect(attestationRead).toEqual(expect.arrayContaining(expected));
    expect(entryRead).toHaveLength(2);
    expect(entryRead).toEqual(expect.arrayContaining([await entryPda(0), await entryPda(1)]));
    expect(book.rows).toHaveLength(3);
  });

  it('reads an entry once when many loans share a build, and none for a missing attestation', async () => {
    const w = await open({
      bookLoans: [{}, {}, { attestation: false }],
    });
    await fetchBook(w.deps, POOL_0, signal());
    expect(w.accountCalls()[2]).toEqual([await entryPda(0)]);
  });

  it('builds rows from the chain: tier, amount, health, build and attestation address', async () => {
    const w = await open({
      bookLoans: [{ amount: 2_500_000n, tier: 2, attestation: liveAttestation({ tier: 2 }) }],
    });
    const book = await fetchBook(w.deps, POOL_0, signal());
    const [only] = w.bookLoans;
    expect(book.rows).toHaveLength(1);
    expect(book.rows[0]).toMatchObject({
      loanAddress: only?.loanAddress,
      borrower: only?.borrower,
      attestationAddress: only?.attestationAddress,
      amount: 2_500_000n,
      tierAtBorrow: 'B',
      currentTier: 'B',
      health: 'valid',
      measurementId: 0,
    });
    expect(book.kpis).toMatchObject({ outstanding: 2_500_000n, openLoans: 1 });
  });

  it('reads the vault balance of the pool', async () => {
    const w = await open({ vault: { 0: 4_200_000n } });
    expect((await fetchBook(w.deps, POOL_0, signal())).kpis.vault).toBe(4_200_000n);
  });

  it('shows only the loans of the asked pool', async () => {
    const w = await open({ bookLoans: [{ pool: 0 }, { pool: 1 }, { pool: 1 }] });
    const book = await fetchBook(w.deps, POOL_1, signal());
    const expected = [w.bookLoans[1]?.borrower ?? '', w.bookLoans[2]?.borrower ?? ''];
    expect(book.rows.map((r) => r.borrower).toSorted(byText)).toEqual(expected.toSorted(byText));
  });

  it('makes a single accounts call, and no entry read, for a pool without loans', async () => {
    const w = await open();
    const book = await fetchBook(w.deps, POOL_0, signal());
    expect(w.accountCalls()).toEqual([[POOL_0, w.vault]]);
    expect(book.rows).toEqual([]);
    expect(book.kpis).toMatchObject({ openLoans: 0, outstanding: 0n });
  });

  it('skips the entry read when no attestation is oracle-signed', async () => {
    const w = await open({
      bookLoans: [{ attestation: false }, { attestation: { signer: OTHER } }],
    });
    const book = await fetchBook(w.deps, POOL_0, signal());
    expect(w.accountCalls()).toHaveLength(2);
    expect(book.rows.map((r) => r.health).toSorted(byText)).toEqual(['foreign_signer', 'none']);
  });

  it('gives each approved build of the pool its registry entry address without reading it', async () => {
    const w = await open();
    const { policy } = await fetchBook(w.deps, POOL_0, signal());
    // The default pool approves builds 0 and 1.
    expect(policy.approvedBuilds).toEqual([
      { id: 0, entryAddress: await entryPda(0) },
      { id: 1, entryAddress: await entryPda(1) },
    ]);
    expect(w.accountCalls().flat()).not.toContain(await entryPda(1));
  });

  it('carries the pool policy of the asked pool', async () => {
    const w = await open();
    const { policy } = await fetchBook(w.deps, POOL_0, signal());
    expect(policy).toMatchObject({
      policyHashHex: '11'.repeat(32),
      tierLimits: [5_000_000n, 3_000_000n, 1_000_000n],
      maxAgeSecs: 2_592_000,
    });
  });

  it('judges health at the current time', async () => {
    const w = await open({
      bookLoans: [
        {
          attestation: {
            payload: { issuedAt: BigInt(Math.floor(Date.now() / 1000)) - 3_000_000n },
          },
        },
      ],
    });
    const book = await fetchBook(w.deps, POOL_0, signal());
    expect(book.rows[0]?.health).toBe('stale');
    expect(book.rows[0]?.outstandingSecs).toBeGreaterThanOrEqual(3600n);
    expect(book.rows[0]?.outstandingSecs).toBeLessThan(3700n);
  });

  it('is a protocol_error when a loan is not at the PDA of its pool and borrower', async () => {
    const w = await open({ bookLoans: [{}] });
    const read = await w.chain.poolLoans(POOL_0, signal());
    const loan = read.ok ? read.value[0]?.loan : undefined;
    if (loan === undefined) throw new Error('no loan in the world');
    expect(OTHER).not.toBe((await findLoanPda({ pool: POOL_0, borrower: loan.borrower }))[0]);
    vi.mocked(w.deps.chain.poolLoans).mockResolvedValue(ok([{ address: OTHER, loan }]));
    await expect(fetchBook(w.deps, POOL_0, signal())).rejects.toMatchObject({
      code: 'protocol_error',
    });
  });

  it('is a protocol_error when the pool is missing', async () => {
    const w = await open();
    w.store.delete(POOL_0);
    await expect(fetchBook(w.deps, POOL_0, signal())).rejects.toMatchObject({
      code: 'protocol_error',
    });
  });

  it('is a protocol_error when the vault is missing', async () => {
    const w = await open();
    w.store.delete(w.vault);
    await expect(fetchBook(w.deps, POOL_0, signal())).rejects.toMatchObject({
      code: 'protocol_error',
    });
  });

  it('is a protocol_error when the pool account is not a pool', async () => {
    const w = await open();
    const vaultAccount = w.store.get(w.vault);
    if (vaultAccount === undefined) throw new Error('no vault');
    w.store.set(POOL_0, vaultAccount);
    await expect(fetchBook(w.deps, POOL_0, signal())).rejects.toMatchObject({
      code: 'protocol_error',
    });
  });

  it('lets an RPC failure on the loans through as its own error', async () => {
    const w = await open();
    vi.mocked(w.deps.chain.poolLoans).mockResolvedValue(fail({ code: 'rpc_busy' }));
    await expect(fetchBook(w.deps, POOL_0, signal())).rejects.toMatchObject({ code: 'rpc_busy' });
  });

  it('lets an RPC failure on the accounts through as its own error', async () => {
    const w = await open({ bookLoans: [{}] });
    vi.mocked(w.deps.chain.accounts).mockResolvedValue(fail({ code: 'network' }));
    await expect(fetchBook(w.deps, POOL_0, signal())).rejects.toMatchObject({ code: 'network' });
  });
});

describe('fetchBook against a misbehaving RPC', () => {
  it('is a protocol_error when the same loan comes back twice', async () => {
    const w = await open({ bookLoans: [{}] });
    const read = await w.chain.poolLoans(POOL_0, signal());
    if (!read.ok) throw new Error('no loans in the world');
    vi.mocked(w.deps.chain.poolLoans).mockResolvedValue(ok([...read.value, ...read.value]));
    await expect(fetchBook(w.deps, POOL_0, signal())).rejects.toMatchObject({
      code: 'protocol_error',
    });
  });

  it('is a protocol_error when an attestation PDA holds another kind of account', async () => {
    const w = await open({ bookLoans: [{}] });
    const [first] = w.bookLoans;
    const vaultAccount = w.store.get(w.vault);
    if (first === undefined || vaultAccount === undefined) throw new Error('world incomplete');
    w.store.set(first.attestationAddress, vaultAccount);
    await expect(fetchBook(w.deps, POOL_0, signal())).rejects.toMatchObject({
      code: 'protocol_error',
    });
  });

  it("is a protocol_error when a borrower's PDA holds another wallet's attestation", async () => {
    const w = await open({ bookLoans: [{}, {}] });
    const [first, second] = w.bookLoans;
    if (first === undefined || second === undefined) throw new Error('world incomplete');
    const other = w.store.get(second.attestationAddress);
    if (other === undefined) throw new Error('no attestation');
    w.store.set(first.attestationAddress, other);
    await expect(fetchBook(w.deps, POOL_0, signal())).rejects.toMatchObject({
      code: 'protocol_error',
    });
  });

  it('is a protocol_error when a registry entry PDA holds another kind of account', async () => {
    const w = await open({ bookLoans: [{}] });
    const vaultAccount = w.store.get(w.vault);
    if (vaultAccount === undefined) throw new Error('no vault');
    w.store.set(await entryPda(0), vaultAccount);
    await expect(fetchBook(w.deps, POOL_0, signal())).rejects.toMatchObject({
      code: 'protocol_error',
    });
  });
});

describe('useBook', () => {
  it('resolves to the book of the pool', async () => {
    const w = await open({ bookLoans: [{ amount: 1_000_000n }] });
    const { result } = renderHook(() => useBook(POOL_0, w.deps), { wrapper: queryWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.rows).toHaveLength(1);
    expect(result.current.data?.kpis.vault).toBe(9_000_000_000n);
  });

  it('turns a failure into an AppError', async () => {
    const w = await open();
    vi.mocked(w.deps.chain.poolLoans).mockResolvedValue(fail({ code: 'rpc_busy' }));
    const { result } = renderHook(() => useBook(POOL_0, w.deps), { wrapper: queryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: 'rpc_busy' });
  });
});
