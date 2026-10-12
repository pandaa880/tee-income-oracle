// The registered enclave builds and the state of each one's registry entry, in one batched read.
import { useQuery } from '@tanstack/react-query';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { type BuildRow, buildRows } from '../domain/builds.ts';
import { toAppError } from '../domain/errors.ts';
import type { AppError } from '../domain/types.ts';
import { type Deps, realDeps } from './deps.ts';
import { queryKeys } from './query-keys.ts';
import { withDeadline } from './use-credential.ts';

export async function fetchBuilds(deps: Deps, signal: AbortSignal): Promise<BuildRow[]> {
  const { enclaves, oracleProgram } = deps.config.verifier;
  const addresses = await Promise.all(
    enclaves.map(
      async ({ measurementId }) =>
        (await findEnclaveEntryPda({ measurementId }, { programAddress: oracleProgram }))[0],
    ),
  );
  const read = await deps.chain.accounts(addresses, signal);
  if (!read.ok) throw read.error;
  // An account at the entry PDA that is not an entry counts as none: the row says "unknown".
  const entries = read.value.map((account) =>
    account?.kind === 'enclave_entry' ? account.entry : null,
  );
  return buildRows(enclaves, entries);
}

export function useBuilds(deps: Deps = realDeps()) {
  return useQuery<BuildRow[], AppError>({
    queryKey: queryKeys.builds(deps.config.cluster),
    queryFn: ({ signal }) =>
      fetchBuilds(deps, withDeadline(signal)).catch((thrown: unknown) => {
        throw toAppError(thrown);
      }),
    staleTime: 60_000,
  });
}
