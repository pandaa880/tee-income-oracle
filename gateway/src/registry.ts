/**
 * Reads this enclave's oracle registry entry (FORMATS §13). The gateway
 * refuses to start unless the entry exists, is active and names the
 * enclave's attester, so a misconfigured `MEASUREMENT_ID` fails at boot, not
 * on a borrower's transaction.
 */
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import {
  ENCLAVE_ENTRY_DISCRIMINATOR,
  type EnclaveEntry,
  findEnclaveEntryPda,
  getEnclaveEntryDecoder,
  getEnclaveEntrySize,
} from '@tio/oracle-client';
import { ORACLE_PROGRAM_ID } from '@tio/oracle-client/attest';

import { gatewayError } from './errors.ts';
import { rpcSignal } from './timeouts.ts';

export type RegistryRpc = Rpc<Pick<SolanaRpcApi, 'getAccountInfo'>>;

/** The entry held by a fetched account, or undefined if it isn't an oracle entry. */
export function entryFromAccount(
  account: { owner: Address; data: Uint8Array } | null,
): EnclaveEntry | undefined {
  if (account === null || account.owner !== ORACLE_PROGRAM_ID) return undefined;
  // The generated decoder checks neither the length nor the discriminator.
  const { data } = account;
  if (data.length !== getEnclaveEntrySize()) throw new Error('enclave entry has the wrong length');
  if (!ENCLAVE_ENTRY_DISCRIMINATOR.every((byte, i) => data[i] === byte)) {
    throw new Error('account is not an oracle EnclaveEntry');
  }
  return getEnclaveEntryDecoder().decode(data);
}

/** The entry at `measurementId`, or undefined if there is none. */
export async function readEnclaveEntry(
  rpc: RegistryRpc,
  measurementId: number,
): Promise<EnclaveEntry | undefined> {
  const [at] = await findEnclaveEntryPda({ measurementId });
  const { value } = await rpc
    .getAccountInfo(at, { encoding: 'base64' })
    .send({ abortSignal: rpcSignal() });
  return entryFromAccount(
    value === null
      ? null
      : { owner: value.owner, data: new Uint8Array(Buffer.from(value.data[0], 'base64')) },
  );
}

export function attesterHex(entry: EnclaveEntry): string {
  return `0x${Buffer.from(entry.attester).toString('hex')}`;
}

export async function checkEnclaveEntry(
  rpc: RegistryRpc,
  measurementId: number,
  expectedAttester: string,
): Promise<void> {
  const entry = await readEnclaveEntry(rpc, measurementId);
  if (entry === undefined) throw gatewayError('enclave_not_registered', 'chain', 503);
  if (entry.revokedAt !== 0n) throw gatewayError('enclave_revoked', 'chain', 503);
  if (attesterHex(entry) !== expectedAttester.toLowerCase()) {
    throw gatewayError('attester_mismatch', 'chain', 503);
  }
}
