// readEntry: the oracle's EnclaveEntry PDA, read through a fake ChainReader with checked decoding.
import {
  ORACLE_PROGRAM_ADDRESS,
  findEnclaveEntryPda,
  getEnclaveEntrySize,
} from '@tio/oracle-client';
import { toHex } from '@tio/encoding';
import { describe, expect, it } from 'vitest';
import {
  ATTESTER_HEX,
  IMAGE_ID_HEX,
  OTHER_ADDRESS,
  entryAccountData,
  expectRejected,
  fakeChain,
} from '../test-fixtures.ts';
import { type RawAccount } from './ports.ts';
import { readEntry } from './registry.ts';

async function chainWith(id: number, change: (account: RawAccount) => RawAccount = (a) => a) {
  const [address] = await findEnclaveEntryPda({ measurementId: id });
  const account = change({
    owner: ORACLE_PROGRAM_ADDRESS,
    data: entryAccountData(1, { measurementId: id }),
  });
  return fakeChain(new Map([[address, account]]));
}

describe('readEntry', () => {
  it('decodes_measurement_attester_doc_hash_and_revocation', async () => {
    const entry = await readEntry(await chainWith(1), ORACLE_PROGRAM_ADDRESS, 1);
    expect(toHex(new Uint8Array(entry.measurement))).toBe(IMAGE_ID_HEX);
    expect(`0x${toHex(new Uint8Array(entry.attester))}`).toBe(ATTESTER_HEX[1]);
    expect(entry.measurementId).toBe(1);
    expect(entry.measurementKind).toBe(1);
    expect(entry.revokedAt).toBe(0n);
  });

  it('entry_account_fixture_has_the_generated_size', () => {
    expect(entryAccountData(1)).toHaveLength(getEnclaveEntrySize());
  });

  it('rejects_a_missing_entry_as_entry_missing', async () => {
    await expectRejected(readEntry(await chainWith(1), ORACLE_PROGRAM_ADDRESS, 2), 'entry_missing');
  });

  it('reads_the_pda_of_the_requested_id_only', async () => {
    const chain = await chainWith(1);
    expect((await readEntry(chain, ORACLE_PROGRAM_ADDRESS, 1)).measurementId).toBe(1);
    await expectRejected(readEntry(chain, ORACLE_PROGRAM_ADDRESS, 0), 'entry_missing');
  });
});

describe('readEntry rejects a malformed account as entry_malformed', () => {
  it('owner_is_not_the_oracle_program', async () => {
    const chain = await chainWith(1, (a) => ({ ...a, owner: OTHER_ADDRESS }));
    await expectRejected(readEntry(chain, ORACLE_PROGRAM_ADDRESS, 1), 'entry_malformed');
  });

  it('length_is_111', async () => {
    const chain = await chainWith(1, (a) => ({ ...a, data: a.data.subarray(0, 111) }));
    await expectRejected(readEntry(chain, ORACLE_PROGRAM_ADDRESS, 1), 'entry_malformed');
  });

  it('length_is_113', async () => {
    const chain = await chainWith(1, (a) => ({ ...a, data: Uint8Array.from([...a.data, 0]) }));
    await expectRejected(readEntry(chain, ORACLE_PROGRAM_ADDRESS, 1), 'entry_malformed');
  });

  it('discriminator_is_wrong', async () => {
    const chain = await chainWith(1, (a) => {
      const data = a.data.slice();
      data[0] = (data[0] ?? 0) ^ 1;
      return { ...a, data };
    });
    await expectRejected(readEntry(chain, ORACLE_PROGRAM_ADDRESS, 1), 'entry_malformed');
  });
});
