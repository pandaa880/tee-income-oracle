import type { Address } from '@solana/kit';
import { getLoanDecoder, type Loan } from '@tio/demo-pool-client';
import type { EnclaveEntry } from '@tio/oracle-client';
import {
  parseSasAttestation,
  SAS_PROGRAM_ID,
  type StoredAttestation,
} from '@tio/oracle-client/attest';
import { describe, expect, it } from 'vitest';
import {
  type Book,
  type BookInput,
  type BookRow,
  buildBook,
  freshnessRules,
  tierMix,
  utilizationBps,
} from './book.ts';
import type { CredentialStatus } from './credential.ts';
import { formatAge } from './format.ts';
import type { Tier } from './types.ts';
import {
  ADMIN,
  CREDENTIAL,
  entry,
  ISSUED_AT,
  loanBytes,
  type LoanOverrides,
  MINT,
  NOW,
  OTHER,
  type PayloadFields,
  payloadBytes,
  pool,
  POOL_0,
  RELAYER,
  SAS_SIGNER,
  sasAccountBytes,
  SCHEMA,
} from '../test-support/fixtures.ts';

const loan = (borrower: Address, amount: bigint, overrides: LoanOverrides = {}): Loan =>
  getLoanDecoder().decode(loanBytes(borrower, amount, overrides));

const stored = (
  borrower: Address,
  payload: Partial<PayloadFields> = {},
  extra: { expiry?: bigint; signer?: Address } = {},
): StoredAttestation =>
  parseSasAttestation(
    SAS_PROGRAM_ID,
    sasAccountBytes({ wallet: borrower, payload: payloadBytes(payload), ...extra }),
  );

const BORROWER = ADMIN;
const LOAN_ADDRESS = CREDENTIAL;
const ATTESTATION_ADDRESS = SCHEMA;
const BUILDS = [{ id: 0, entryAddress: OTHER }];

type Entries = ReadonlyMap<number, EnclaveEntry>;

function input(overrides: Partial<BookInput> = {}): BookInput {
  return {
    pool: pool(),
    vault: 9_000_000n,
    loans: [],
    attestations: new Map(),
    entries: new Map([[0, entry()]]),
    approvedBuilds: BUILDS,
    sasSigner: SAS_SIGNER,
    now: NOW,
    ...overrides,
  };
}

/** One loan by BORROWER with this attestation (or none), judged at NOW. */
function singleRow(
  attestation: StoredAttestation | undefined,
  options: { loan?: Loan; entries?: Entries } = {},
): BookRow {
  const book = buildBook(
    input({
      loans: [{ address: LOAN_ADDRESS, loan: options.loan ?? loan(BORROWER, 2_000_000n) }],
      attestations: new Map([[BORROWER, { address: ATTESTATION_ADDRESS, stored: attestation }]]),
      ...(options.entries === undefined ? {} : { entries: options.entries }),
    }),
  );
  const [row] = book.rows;
  if (row === undefined) throw new Error('no row built');
  return row;
}

describe('utilizationBps', () => {
  it('is null when nothing is outstanding and the vault is empty', () => {
    expect(utilizationBps(0n, 0n)).toBeNull();
  });

  it('is 0 with nothing outstanding and money in the vault', () => {
    expect(utilizationBps(0n, 7_500n)).toBe(0);
  });

  it('is outstanding over outstanding plus vault, in basis points', () => {
    expect(utilizationBps(2_500n, 7_500n)).toBe(2500);
  });

  it('is 10000 when the vault is empty', () => {
    expect(utilizationBps(4_000n, 0n)).toBe(10_000);
  });

  it('floors instead of rounding', () => {
    expect(utilizationBps(1n, 2n)).toBe(3333);
    expect(utilizationBps(2n, 1n)).toBe(6666);
  });

  it('stays exact for amounts beyond Number precision', () => {
    const huge = 10n ** 30n;
    expect(utilizationBps(huge, huge * 3n)).toBe(2500);
  });
});

const row = (tier: Tier | null, amount: bigint): BookRow => ({
  loanAddress: LOAN_ADDRESS,
  borrower: BORROWER,
  attestationAddress: ATTESTATION_ADDRESS,
  tierAtBorrow: tier,
  amount,
  outstandingSecs: 0n,
  health: 'valid',
  currentTier: tier,
  tierAgeSecs: 0n,
  measurementId: 0,
  reattested: false,
});

describe('tierMix', () => {
  it('counts rows and sums principal per tier at borrow', () => {
    const mix = tierMix([row('A', 100n), row('A', 300n), row('B', 400n), row('C', 200n)]);
    expect(mix.A).toMatchObject({ count: 2, principal: 400n });
    expect(mix.B).toMatchObject({ count: 1, principal: 400n });
    expect(mix.C).toMatchObject({ count: 1, principal: 200n });
  });

  it('gives each tier its share of outstanding in basis points, floored', () => {
    const mix = tierMix([row('A', 1n), row('B', 1n), row('C', 1n)]);
    expect([mix.A.shareBps, mix.B.shareBps, mix.C.shareBps]).toEqual([3333, 3333, 3333]);
    expect(tierMix([row('A', 100n), row('B', 300n)]).B.shareBps).toBe(7500);
  });

  it('is all zeros without rows', () => {
    const zero = { count: 0, principal: 0n, shareBps: 0 };
    expect(tierMix([])).toEqual({ A: zero, B: zero, C: zero });
  });

  it('leaves a loan with an unknown tier out of every count and share', () => {
    const mix = tierMix([row(null, 900n), row('A', 100n)]);
    expect(mix.A).toEqual({ count: 1, principal: 100n, shareBps: 10_000 });
    expect(mix.B.count + mix.C.count).toBe(0);
  });
});

describe('buildBook rows', () => {
  const HEALTH: [string, CredentialStatus, () => StoredAttestation | undefined, Entries?][] = [
    ['fresh', 'valid', () => stored(BORROWER)],
    [
      'older than the pool accepts',
      'stale',
      () => stored(BORROWER, { issuedAt: NOW - 2_592_001n }),
    ],
    ['past its expiry', 'expired', () => stored(BORROWER, {}, { expiry: NOW - 1n })],
    [
      'issued by a retired build',
      'enclave_revoked',
      () => stored(BORROWER),
      new Map([[0, entry({ revokedAt: 5n })]]),
    ],
    [
      'issued by a build the pool does not approve',
      'not_approved',
      () => stored(BORROWER, { measurementId: 5 }),
    ],
    [
      'checked against another policy',
      'policy_mismatch',
      () => stored(BORROWER, { policyHash: new Uint8Array(32).fill(0x22) }),
    ],
    ['absent', 'none', () => undefined],
    [
      'written by a foreign signer',
      'foreign_signer',
      () => stored(BORROWER, {}, { signer: OTHER }),
    ],
  ];

  it.each(HEALTH)(
    'judges an attestation %s as %s through readCredentialRecord',
    (_, status, make, entries) => {
      const attestation = make();
      expect(singleRow(attestation, entries === undefined ? {} : { entries }).health).toBe(status);
    },
  );

  it('reads the current tier, its age and the build off an oracle-signed attestation', () => {
    const r = singleRow(stored(BORROWER, { tier: 2, issuedAt: NOW - 500n, measurementId: 0 }));
    expect(r).toMatchObject({ currentTier: 'B', tierAgeSecs: 500n, measurementId: 0 });
  });

  it('carries the addresses and the principal of the loan', () => {
    expect(singleRow(stored(BORROWER))).toMatchObject({
      loanAddress: LOAN_ADDRESS,
      borrower: BORROWER,
      attestationAddress: ATTESTATION_ADDRESS,
      amount: 2_000_000n,
    });
  });

  it('shows tier, tier age and build as null when there is no attestation', () => {
    expect(singleRow(undefined)).toMatchObject({
      currentTier: null,
      tierAgeSecs: null,
      measurementId: null,
      reattested: false,
    });
  });

  it('shows tier, tier age and build as null for a foreign signer, whatever its payload says', () => {
    const r = singleRow(stored(BORROWER, { tier: 3, measurementId: 4 }, { signer: OTHER }));
    expect(r).toMatchObject({
      health: 'foreign_signer',
      currentTier: null,
      tierAgeSecs: null,
      measurementId: null,
      reattested: false,
    });
  });

  it.each([
    [1, 'A'],
    [2, 'B'],
    [3, 'C'],
    [0, null],
    [4, null],
  ])('maps the Loan tier byte %i to %s', (byte, tier) => {
    const r = singleRow(stored(BORROWER), { loan: loan(BORROWER, 1n, { tier: byte }) });
    expect(r.tierAtBorrow).toBe(tier);
  });

  it('is not re-attested while the attestation is the one the loan was borrowed on', () => {
    const r = singleRow(stored(BORROWER, { issuedAt: ISSUED_AT }), {
      loan: loan(BORROWER, 1n, { attestationIssuedAt: ISSUED_AT }),
    });
    expect(r.reattested).toBe(false);
  });

  it('is re-attested when the attestation was issued after the loan was taken, and keeps tier at borrow', () => {
    const r = singleRow(stored(BORROWER, { tier: 3, issuedAt: NOW - 10n }), {
      loan: loan(BORROWER, 1n, { tier: 1, attestationIssuedAt: ISSUED_AT }),
    });
    expect(r).toMatchObject({ reattested: true, tierAtBorrow: 'A', currentTier: 'C' });
  });

  it('counts a stale attestation that differs from the loan as re-attested too', () => {
    const r = singleRow(stored(BORROWER, { issuedAt: NOW - 3_000_000n }), {
      loan: loan(BORROWER, 1n, { attestationIssuedAt: ISSUED_AT }),
    });
    expect(r).toMatchObject({ health: 'stale', reattested: true });
  });

  it('measures how long the loan has been outstanding', () => {
    const r = singleRow(stored(BORROWER), {
      loan: loan(BORROWER, 1n, { borrowedAt: NOW - 7200n }),
    });
    expect(r.outstandingSecs).toBe(7200n);
  });

  it('clamps the ages to zero when the timestamps are in the future', () => {
    const r = singleRow(stored(BORROWER, { issuedAt: NOW + 50n }), {
      loan: loan(BORROWER, 1n, { borrowedAt: NOW + 99n }),
    });
    expect(r).toMatchObject({ outstandingSecs: 0n, tierAgeSecs: 0n });
  });
});

describe('buildBook ordering and totals', () => {
  const A = loan(BORROWER, 1_000_000n, { borrowedAt: NOW - 300n });
  const B = loan(OTHER, 2_000_000n, { borrowedAt: NOW - 100n });
  const C = loan(MINT, 4_000_000n, { borrowedAt: NOW - 300n });
  const ADDRESS_A = RELAYER;
  const ADDRESS_B = POOL_0;
  const ADDRESS_C = ADMIN;

  const book = (): Book =>
    buildBook(
      input({
        loans: [
          { address: ADDRESS_A, loan: A },
          { address: ADDRESS_B, loan: B },
          { address: ADDRESS_C, loan: C },
        ],
        vault: 3_000_000n,
      }),
    );

  it('lists the newest loan first and breaks ties by loan address ascending', () => {
    // Plain code-unit order, as the book sorts addresses.
    const tied = [ADDRESS_A, ADDRESS_C].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(book().rows.map((r) => r.loanAddress)).toEqual([ADDRESS_B, ...tied]);
  });

  it('sums the principal outstanding and counts the open loans', () => {
    expect(book().kpis).toMatchObject({ outstanding: 7_000_000n, openLoans: 3 });
  });

  it('passes the vault balance through and derives utilization from it', () => {
    expect(book().kpis).toMatchObject({ vault: 3_000_000n, utilizationBps: 7000 });
  });

  it('has a null utilization for an empty book and an empty vault', () => {
    expect(buildBook(input({ vault: 0n })).kpis).toEqual({
      outstanding: 0n,
      utilizationBps: null,
      openLoans: 0,
      vault: 0n,
    });
  });

  it('has 0% utilization for an empty book with money in the vault', () => {
    expect(buildBook(input()).kpis.utilizationBps).toBe(0);
  });

  it('mixes tiers by principal at borrow', () => {
    const mixed = buildBook(
      input({
        loans: [
          { address: ADDRESS_A, loan: loan(BORROWER, 100n, { tier: 1 }) },
          { address: ADDRESS_B, loan: loan(OTHER, 300n, { tier: 2 }) },
        ],
      }),
    ).tierMix;
    expect(mixed.A).toMatchObject({ count: 1, shareBps: 2500 });
    expect(mixed.B).toMatchObject({ count: 1, principal: 300n, shareBps: 7500 });
  });
});

describe('buildBook policy', () => {
  it('shows the policy hash as lower-case hex, the limits, the windows and the approved builds', () => {
    const { policy } = buildBook(
      input({ pool: pool({ policyHash: Uint8Array.of(0xab, ...new Uint8Array(31).fill(0x0c)) }) }),
    );
    expect(policy.policyHashHex).toBe(`ab${'0c'.repeat(31)}`);
    expect(policy.tierLimits).toEqual([5_000_000n, 3_000_000n, 1_000_000n]);
    expect(policy).toMatchObject({
      maxAgeSecs: 2_592_000,
      maxWindowAgeSecs: 31_536_000,
      minWindowSecs: 7_776_000,
      approvedBuilds: BUILDS,
    });
  });
});

describe('freshnessRules', () => {
  it('words the three freshness limits of the pool with formatAge', () => {
    const { params } = pool();
    expect(freshnessRules(params)).toEqual([
      `tier ≤ ${formatAge(params.maxAgeSecs)} old`,
      `statement ends ≤ ${formatAge(params.maxWindowAgeSecs)} before the tier`,
      `statement covers ≥ ${formatAge(params.minWindowSecs)}`,
    ]);
    expect(freshnessRules(params)[0]).toBe('tier ≤ 30 days old');
  });

  it('follows the params it is given', () => {
    const { params } = pool({ maxAgeSecs: 7200, minWindowSecs: 86_400 });
    const rules = freshnessRules(params);
    expect(rules[0]).toBe('tier ≤ 2 h old');
    expect(rules[2]).toBe('statement covers ≥ 1 days');
  });
});
