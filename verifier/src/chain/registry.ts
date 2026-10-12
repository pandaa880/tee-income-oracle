/** The oracle's `EnclaveEntry` at a measurement id (FORMATS §13), read raw and decoded with checks. */
import type { Address } from '@solana/kit';
import { type EnclaveEntry, findEnclaveEntryPda } from '@tio/oracle-client';
import { parseEnclaveEntry } from '@tio/oracle-client/attest';
import { VerifierError } from '../errors.ts';
import type { ChainReader } from './ports.ts';

/** @throws VerifierError `entry_missing` | `entry_malformed` */
export async function readEntry(
  chain: ChainReader,
  oracleProgram: Address,
  measurementId: number,
): Promise<EnclaveEntry> {
  const [address] = await findEnclaveEntryPda({ measurementId }, { programAddress: oracleProgram });
  const account = await chain.account(address);
  if (account === null) {
    throw new VerifierError(
      'entry_missing',
      `no enclave entry for measurement id ${measurementId}`,
    );
  }
  if (account.owner !== oracleProgram) {
    throw new VerifierError('entry_malformed', 'enclave entry is not owned by the oracle program');
  }
  try {
    return parseEnclaveEntry(account.owner, account.data);
  } catch (error) {
    throw new VerifierError(
      'entry_malformed',
      error instanceof Error ? error.message : 'enclave entry is not readable',
    );
  }
}
