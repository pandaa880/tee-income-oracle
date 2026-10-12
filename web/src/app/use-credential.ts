// The borrower's credential health for one pool, read from chain and judged in the browser.
import type { Address } from '@solana/kit';
import {
  type QueryClient,
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress, decodePayload } from '@tio/oracle-client/attest';
import { type Deps, realDeps } from './deps.ts';
import { queryKeys } from './query-keys.ts';
import { type CredentialRecord, readCredentialRecord } from '../domain/credential.ts';
import { toAppError } from '../domain/errors.ts';
import type { AppError } from '../domain/types.ts';

/** The credential plus the attestation account it was read from (the explorer link target). */
export type CredentialRead = CredentialRecord & { attestation: Address };

/** Reads the attestation and pool, then the registry entry of the payload's enclave build. */
export async function fetchCredential(
  deps: Deps,
  wallet: Address,
  poolAddress: Address,
  signal: AbortSignal,
): Promise<CredentialRead> {
  const { credential, schema, sasSigner } = deps.config.deployment;
  const at = await attestationAddress(credential, schema, wallet);
  const first = await deps.chain.accounts([at, poolAddress], signal);
  if (!first.ok) throw first.error;
  const [stored, poolAccount] = first.value;
  const attestation = stored?.kind === 'attestation' ? stored.attestation : undefined;
  const pool = poolAccount?.kind === 'pool' ? poolAccount.pool : undefined;
  if (pool === undefined) throw { code: 'protocol_error' } satisfies AppError;
  let enclaveEntry;
  if (attestation !== undefined) {
    const { measurementId } = decodePayload(attestation.payload);
    const [entryAddress] = await findEnclaveEntryPda({ measurementId });
    const second = await deps.chain.accounts([entryAddress], signal);
    if (!second.ok) throw second.error;
    const [account] = second.value;
    enclaveEntry = account?.kind === 'enclave_entry' ? account.entry : undefined;
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    ...readCredentialRecord({ attestation, enclaveEntry, pool, sasSigner, now }),
    attestation: at,
  };
}

/** Query reads give up after 15 s, so a hung RPC can't leave a badge loading forever. */
export const withDeadline = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

export type CredentialOptions = {
  /**
   * Re-read every 3 s: always (`true`), or while the predicate holds for the latest read (a
   * dropped stream, or a fresh result the chain read doesn't show yet).
   */
  poll?: boolean | ((latest: CredentialRead | undefined) => boolean);
  /**
   * Starts a fresh read when it changes (e.g. the payload of a just-reported result), instead of
   * waiting for the next poll; the prefix stays the same, so loan invalidation still matches.
   */
  epoch?: string | undefined;
};

const POLL_MS = 3_000;

function pollEvery(poll: CredentialOptions['poll'], latest: CredentialRead | undefined) {
  const on = typeof poll === 'function' ? poll(latest) : poll === true;
  return on ? POLL_MS : false;
}

function credentialQuery(
  client: QueryClient,
  deps: Deps,
  wallet: Address,
  poolAddress: Address,
  options: CredentialOptions,
) {
  const baseKey = [...queryKeys.credential(deps.config.cluster, wallet), poolAddress] as const;
  const { epoch } = options;
  return queryOptions<CredentialRead, AppError>({
    queryKey: epoch === undefined ? baseKey : [...baseKey, epoch],
    queryFn: async ({ signal }) => {
      try {
        const read = await fetchCredential(deps, wallet, poolAddress, withDeadline(signal));
        // An epoch read is the freshest there is: other views (the loan page) use the base key.
        if (epoch !== undefined) client.setQueryData(baseKey, read);
        return read;
      } catch (thrown) {
        throw toAppError(thrown);
      }
    },
    staleTime: 15_000,
    refetchInterval: (query) => pollEvery(options.poll, query.state.data),
  });
}

export function useCredential(
  wallet: Address,
  poolAddress: Address,
  deps: Deps = realDeps(),
  options: CredentialOptions = {},
) {
  const client = useQueryClient();
  return useQuery(credentialQuery(client, deps, wallet, poolAddress, options));
}

/** One credential read per pool (the same wallet can be accepted by one pool and not another). */
export function useCredentials(
  wallet: Address,
  pools: readonly Address[],
  deps: Deps = realDeps(),
  options: CredentialOptions = {},
) {
  const client = useQueryClient();
  return useQueries({
    queries: pools.map((pool) => credentialQuery(client, deps, wallet, pool, options)),
  });
}
