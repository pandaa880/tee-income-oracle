// One pool's loan book, read from chain: the pool and vault, every open Loan, each borrower's
// attestation and the registry entry of each build those attestations name.
import type { Address } from '@solana/kit';
import { useQuery } from '@tanstack/react-query';
import { type Pool, findLoanPda, findVaultPda } from '@tio/demo-pool-client';
import { type EnclaveEntry, findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress } from '@tio/oracle-client/attest';
import { type Deps, realDeps } from './deps.ts';
import { queryKeys } from './query-keys.ts';
import { withDeadline } from './use-credential.ts';
import {
  type ApprovedBuild,
  type Book,
  type HeldAttestation,
  buildBook,
  oracleBuild,
} from '../domain/book.ts';
import { approvedIds } from '../domain/credential.ts';
import { toAppError } from '../domain/errors.ts';
import type { PoolLoan } from '../domain/ports.ts';
import type { AppError } from '../domain/types.ts';

const PROTOCOL_ERROR: AppError = { code: 'protocol_error' };

const entryAddress = async (measurementId: number): Promise<Address> =>
  (await findEnclaveEntryPda({ measurementId }))[0];

/** The loans and the pool with its vault, read side by side. */
async function readPool(deps: Deps, pool: Address, signal: AbortSignal) {
  const [vault] = await findVaultPda({ pool });
  const [loans, accounts] = await Promise.all([
    deps.chain.poolLoans(pool, signal),
    deps.chain.accounts([pool, vault], signal),
  ]);
  if (!loans.ok) throw loans.error;
  if (!accounts.ok) throw accounts.error;
  const [poolAccount, vaultAccount] = accounts.value;
  if (poolAccount?.kind !== 'pool' || vaultAccount?.kind !== 'token') throw PROTOCOL_ERROR;
  return { loans: loans.value, pool: poolAccount.pool, vault: vaultAccount.token.amount };
}

/**
 * A Loan only counts once and at its own PDA: anything else is not this pool's loan for that
 * borrower, and a repeated row would inflate every total.
 */
async function checkLoanAddresses(pool: Address, loans: readonly PoolLoan[]): Promise<void> {
  if (new Set(loans.map((l) => l.address)).size !== loans.length) throw PROTOCOL_ERROR;
  const expected = await Promise.all(
    loans.map(async ({ loan }) => (await findLoanPda({ pool, borrower: loan.borrower }))[0]),
  );
  if (loans.some(({ address }, i) => address !== expected[i])) throw PROTOCOL_ERROR;
}

/** One attestation PDA per borrower, read in one call (none for an empty book). */
async function readAttestations(
  deps: Deps,
  loans: readonly PoolLoan[],
  signal: AbortSignal,
): Promise<Map<Address, HeldAttestation>> {
  if (loans.length === 0) return new Map();
  const { credential, schema } = deps.config.deployment;
  const pairs = await Promise.all(
    loans.map(async ({ loan }) => ({
      borrower: loan.borrower,
      address: await attestationAddress(credential, schema, loan.borrower),
    })),
  );
  const read = await deps.chain.accounts(
    pairs.map((p) => p.address),
    signal,
  );
  if (!read.ok) throw read.error;
  return new Map(
    pairs.map(({ borrower, address }, i): [Address, HeldAttestation] => {
      const account = read.value[i] ?? null;
      if (account === null) return [borrower, { address, stored: undefined }];
      // Anything at this PDA but the borrower's own SAS attestation is a bad read.
      if (account.kind !== 'attestation' || account.attestation.nonce !== borrower) {
        throw PROTOCOL_ERROR;
      }
      return [borrower, { address, stored: account.attestation }];
    }),
  );
}

/** The registry entry of every build an oracle-signed attestation names, each read once. */
async function readEntries(
  deps: Deps,
  held: Iterable<HeldAttestation>,
  signal: AbortSignal,
): Promise<Map<number, EnclaveEntry>> {
  const { sasSigner } = deps.config.deployment;
  const ids = new Set<number>();
  for (const { stored } of held) {
    const build = oracleBuild(stored, sasSigner);
    if (build !== null) ids.add(build);
  }
  if (ids.size === 0) return new Map();
  const list = [...ids];
  const read = await deps.chain.accounts(await Promise.all(list.map(entryAddress)), signal);
  if (!read.ok) throw read.error;
  const entries = new Map<number, EnclaveEntry>();
  list.forEach((id, i) => {
    const account = read.value[i] ?? null;
    if (account === null) return;
    if (account.kind !== 'enclave_entry') throw PROTOCOL_ERROR;
    entries.set(id, account.entry);
  });
  return entries;
}

/** The builds the pool approves, each with its registry entry address (derived, not read). */
const approvedBuilds = (pool: Pool): Promise<ApprovedBuild[]> =>
  Promise.all(
    approvedIds(pool.params.approvedMeasurements).map(async (id) => ({
      id,
      entryAddress: await entryAddress(id),
    })),
  );

export async function fetchBook(deps: Deps, pool: Address, signal: AbortSignal): Promise<Book> {
  const read = await readPool(deps, pool, signal);
  await checkLoanAddresses(pool, read.loans);
  const attestations = await readAttestations(deps, read.loans, signal);
  const entries = await readEntries(deps, attestations.values(), signal);
  return buildBook({
    pool: read.pool,
    vault: read.vault,
    loans: read.loans,
    attestations,
    entries,
    approvedBuilds: await approvedBuilds(read.pool),
    sasSigner: deps.config.deployment.sasSigner,
    now: BigInt(Math.floor(Date.now() / 1000)),
  });
}

const REFRESH_MS = 30_000;

/** Re-read every 30 s and on window focus: a funder's view should follow the chain. */
export function useBook(pool: Address, deps: Deps = realDeps()) {
  return useQuery<Book, AppError>({
    queryKey: queryKeys.book(deps.config.cluster, pool),
    queryFn: ({ signal }) =>
      fetchBook(deps, pool, withDeadline(signal)).catch((thrown: unknown) => {
        throw toAppError(thrown);
      }),
    staleTime: 15_000,
    refetchInterval: REFRESH_MS,
  });
}
