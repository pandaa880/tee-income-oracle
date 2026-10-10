// The borrower's credential health for one pool, read from chain and judged in the browser.
import type { Address } from '@solana/kit';
import { useQuery } from '@tanstack/react-query';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress, decodePayload } from '@tio/oracle-client/attest';
import { type Deps, realDeps } from './deps.ts';
import { queryKeys } from './query-keys.ts';
import { type CredentialStatus, readCredential } from '../domain/credential.ts';
import { toAppError } from '../domain/errors.ts';
import type { AppError } from '../domain/types.ts';

/** Reads the attestation and pool, then the registry entry of the payload's enclave build. */
export async function fetchCredential(
  deps: Deps,
  wallet: Address,
  poolAddress: Address,
  signal: AbortSignal,
): Promise<CredentialStatus> {
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
  return readCredential({ attestation, enclaveEntry, pool, sasSigner, now });
}

/** Query reads give up after 15 s, so a hung RPC can't leave a badge loading forever. */
export const withDeadline = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

export function useCredential(wallet: Address, poolAddress: Address, deps: Deps = realDeps()) {
  return useQuery<CredentialStatus, AppError>({
    queryKey: [...queryKeys.credential(deps.config.cluster, wallet), poolAddress],
    queryFn: ({ signal }) =>
      fetchCredential(deps, wallet, poolAddress, withDeadline(signal)).catch((thrown: unknown) => {
        throw toAppError(thrown);
      }),
    staleTime: 15_000,
  });
}
