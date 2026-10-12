// Builds a `CredentialRecord` for domain and component tests. Not a test file.
import type { CredentialRecord } from '../domain/credential.ts';
import { decodePayload } from '@tio/oracle-client/attest';
import { NOW, payloadBytes, type PayloadFields } from './fixtures.ts';

export function credentialRecord(
  status: CredentialRecord['status'] = 'valid',
  options: { limit?: bigint; payload?: Partial<PayloadFields>; withRecord?: boolean } = {},
): CredentialRecord {
  const withRecord = options.withRecord ?? status !== 'none';
  return {
    status,
    limit: options.limit ?? (status === 'none' ? 0n : 5_000_000n),
    record: withRecord
      ? { payload: decodePayload(payloadBytes(options.payload)), expiry: NOW + 10_000n }
      : null,
  };
}
