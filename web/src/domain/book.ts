// The loan book a funder sees for one pool: every open loan with the health of the credential
// behind it, judged in the browser from chain reads by the same rules as `borrow`.
import type { Address } from '@solana/kit';
import type { Pool } from '@tio/demo-pool-client';
import type { EnclaveEntry } from '@tio/oracle-client';
import { type StoredAttestation, decodePayload } from '@tio/oracle-client/attest';
import { type CredentialStatus, readCredentialRecord, tierFromByte } from './credential.ts';
import { formatAge, hexOf } from './format.ts';
import type { PoolLoan } from './ports.ts';
import type { Tier } from './types.ts';

export type BookRow = {
  loanAddress: Address;
  borrower: Address;
  /** The borrower's attestation PDA; null only when the caller didn't read one. */
  attestationAddress: Address | null;
  /** The Loan's own tier byte; null only for a byte outside 1..3. */
  tierAtBorrow: Tier | null;
  amount: bigint;
  outstandingSecs: bigint;
  /** The borrower's current attestation, judged against this pool. */
  health: CredentialStatus;
  /** The next three are null without an attestation or for a foreign signer's record. */
  currentTier: Tier | null;
  tierAgeSecs: bigint | null;
  measurementId: number | null;
  /** The current attestation is not the one the loan was made on. */
  reattested: boolean;
};

/** One tier's open loans; `shareBps` is its part of the principal of loans with a known tier. */
export type TierShare = { count: number; principal: bigint; shareBps: number };

export type ApprovedBuild = { id: number; entryAddress: Address };

export type Book = {
  policy: {
    policyHashHex: string;
    tierLimits: readonly [bigint, bigint, bigint];
    maxAgeSecs: number;
    maxWindowAgeSecs: number;
    minWindowSecs: number;
    approvedBuilds: readonly ApprovedBuild[];
  };
  kpis: { outstanding: bigint; utilizationBps: number | null; openLoans: number; vault: bigint };
  tierMix: Record<Tier, TierShare>;
  /** Newest loan first. */
  rows: readonly BookRow[];
};

/** A borrower's attestation PDA and what it holds (`undefined` = no account). */
export type HeldAttestation = { address: Address; stored: StoredAttestation | undefined };

export type BookInput = {
  pool: Pool;
  vault: bigint;
  loans: readonly PoolLoan[];
  /** By borrower. */
  attestations: ReadonlyMap<Address, HeldAttestation>;
  entries: ReadonlyMap<number, EnclaveEntry>;
  approvedBuilds: readonly ApprovedBuild[];
  sasSigner: Address;
  /** Unix seconds. */
  now: bigint;
};

const ageSince = (now: bigint, then: bigint): bigint => (now > then ? now - then : 0n);

/**
 * The enclave build an attestation names, but only when the oracle signed it: a foreign record's
 * fields are not the oracle's word, so neither its build nor its tier is read or shown.
 */
export function oracleBuild(
  stored: StoredAttestation | undefined,
  sasSigner: Address,
): number | null {
  if (stored === undefined || stored.signer !== sasSigner) return null;
  return decodePayload(stored.payload).measurementId;
}

/** `part` of `whole` in basis points, rounded down; exact for any bigint. */
const basisPoints = (part: bigint, whole: bigint): number => Number((part * 10_000n) / whole);

/** Outstanding ÷ (outstanding + vault) in basis points; null when both are zero. */
export function utilizationBps(outstanding: bigint, vault: bigint): number | null {
  const total = outstanding + vault;
  return total === 0n ? null : basisPoints(outstanding, total);
}

/** Count and principal per tier at borrow; a loan with an unknown tier byte is left out. */
export function tierMix(rows: readonly BookRow[]): Record<Tier, TierShare> {
  const counted = rows.filter((r) => r.tierAtBorrow !== null);
  const total = counted.reduce((sum, r) => sum + r.amount, 0n);
  const share = (tier: Tier): TierShare => {
    const mine = counted.filter((r) => r.tierAtBorrow === tier);
    const principal = mine.reduce((sum, r) => sum + r.amount, 0n);
    return {
      count: mine.length,
      principal,
      shareBps: total === 0n ? 0 : basisPoints(principal, total),
    };
  };
  return { A: share('A'), B: share('B'), C: share('C') };
}

/** The pool's three freshness limits, as the policy card lists them. */
export function freshnessRules(
  params: Pick<Pool['params'], 'maxAgeSecs' | 'maxWindowAgeSecs' | 'minWindowSecs'>,
): readonly string[] {
  return [
    `tier ≤ ${formatAge(params.maxAgeSecs)} old`,
    `statement ends ≤ ${formatAge(params.maxWindowAgeSecs)} before the tier`,
    `statement covers ≥ ${formatAge(params.minWindowSecs)}`,
  ];
}

function bookRow(input: BookInput, { address, loan }: PoolLoan): BookRow {
  const { pool, entries, sasSigner, now } = input;
  const held = input.attestations.get(loan.borrower);
  const attestation = held?.stored;
  const build = oracleBuild(attestation, sasSigner);
  const { status, record } = readCredentialRecord({
    attestation,
    enclaveEntry: build === null ? undefined : entries.get(build),
    pool,
    sasSigner,
    now,
  });
  const payload = build === null ? undefined : record?.payload;
  return {
    loanAddress: address,
    borrower: loan.borrower,
    attestationAddress: held?.address ?? null,
    tierAtBorrow: tierFromByte(loan.tier),
    amount: loan.amount,
    outstandingSecs: ageSince(now, loan.borrowedAt),
    health: status,
    currentTier: payload === undefined ? null : tierFromByte(payload.tier),
    tierAgeSecs: payload === undefined ? null : ageSince(now, payload.issuedAt),
    measurementId: payload?.measurementId ?? null,
    reattested: payload !== undefined && payload.issuedAt !== loan.attestationIssuedAt,
  };
}

/** Newest loan first; equal times by loan address (code-unit order) so the order is stable. */
function newestFirst(a: PoolLoan, b: PoolLoan): number {
  if (a.loan.borrowedAt !== b.loan.borrowedAt)
    return a.loan.borrowedAt > b.loan.borrowedAt ? -1 : 1;
  if (a.address === b.address) return 0;
  return a.address < b.address ? -1 : 1;
}

/** The whole book of one pool: its rules, KPIs, tier mix and rows (newest loan first). */
export function buildBook(input: BookInput): Book {
  const { pool, vault } = input;
  const rows = input.loans.toSorted(newestFirst).map((loan) => bookRow(input, loan));
  const outstanding = rows.reduce((sum, r) => sum + r.amount, 0n);
  const [a = 0n, b = 0n, c = 0n] = pool.params.tierLimits;
  return {
    policy: {
      policyHashHex: hexOf(Uint8Array.from(pool.params.policyHash)),
      tierLimits: [a, b, c],
      maxAgeSecs: pool.params.maxAgeSecs,
      maxWindowAgeSecs: pool.params.maxWindowAgeSecs,
      minWindowSecs: pool.params.minWindowSecs,
      approvedBuilds: input.approvedBuilds,
    },
    kpis: {
      outstanding,
      utilizationBps: utilizationBps(outstanding, vault),
      openLoans: rows.length,
      vault,
    },
    tierMix: tierMix(rows),
    rows,
  };
}
