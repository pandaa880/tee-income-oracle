// readLoanPools: the served pools' credential and schema, read once at boot through a checked
// decode. Anything at a listed address that isn't a demo-pool Pool stops the gateway.
import { type Address, address } from '@solana/kit';
import {
  DEMO_POOL_PROGRAM_ADDRESS,
  POOL_DISCRIMINATOR,
  getPoolEncoder,
} from '@tio/demo-pool-client';
import { describe, expect, it } from 'vitest';

import type { RawAccount } from './chain.ts';
import { ConfigError } from './config.ts';
import { readLoanPools } from './loan-pools.ts';

const POOL_A = address('HNx4j5GqjiHpHWHZfdwa9vJVoQJfFcuHicHtGpEHtQcx');
const POOL_B = address('C4MwVjB3hDiCaAWXQsCAViM3AHHyirDkyjpRw7EzBgNn');
const CREDENTIAL_A = address('F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7');
const CREDENTIAL_B = address('HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8');
const SCHEMA = address('991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV');
const ADMIN = address('3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND');

function poolAccount(credential: Address): RawAccount {
  const data = getPoolEncoder().encode({
    version: 1,
    bump: 255,
    vaultBump: 254,
    poolId: 0,
    admin: ADMIN,
    mint: ADMIN,
    credential,
    schema: SCHEMA,
    params: {
      policyHash: new Uint8Array(32),
      tierLimits: [3n, 2n, 1n],
      maxAgeSecs: 1,
      maxWindowAgeSecs: 1,
      minWindowSecs: 1,
      approvedMeasurements: new Uint8Array(32),
    },
  });
  return { owner: DEMO_POOL_PROGRAM_ADDRESS, data: new Uint8Array(data) };
}

const chainWith = (accounts: Map<Address, RawAccount>) => ({
  account: async (at: Address) => accounts.get(at) ?? null,
});

describe('readLoanPools', () => {
  it('returns each listed pool with the credential and schema stored on chain', async () => {
    const chain = chainWith(
      new Map<Address, RawAccount>([
        [POOL_A, poolAccount(CREDENTIAL_A)],
        [POOL_B, poolAccount(CREDENTIAL_B)],
      ]),
    );
    expect(await readLoanPools(chain, [POOL_A, POOL_B])).toEqual([
      { address: POOL_A, credential: CREDENTIAL_A, schema: SCHEMA },
      { address: POOL_B, credential: CREDENTIAL_B, schema: SCHEMA },
    ]);
  });

  it('returns no pools for an empty list without reading', async () => {
    expect(await readLoanPools(chainWith(new Map()), [])).toEqual([]);
  });

  const valid = poolAccount(CREDENTIAL_A);
  it.each<[string, RawAccount | undefined]>([
    ['is missing', undefined],
    ['is owned by another program', { ...valid, owner: ADMIN }],
    ['has the wrong length', { ...valid, data: valid.data.subarray(1) }],
    [
      'has another discriminator',
      { ...valid, data: Uint8Array.from(valid.data, (b, i) => (i === 0 ? b ^ 1 : b)) },
    ],
  ])('stops at boot, naming the address, when a listed pool %s', async (_name, account) => {
    const chain = chainWith(
      new Map<Address, RawAccount>(account === undefined ? [] : [[POOL_A, account]]),
    );
    const read = readLoanPools(chain, [POOL_A]);
    await expect(read).rejects.toThrow(ConfigError);
    await expect(read).rejects.toThrow(POOL_A);
  });

  it('checks the discriminator the generated client defines', () => {
    expect(Array.from(valid.data.subarray(0, 8))).toEqual(Array.from(POOL_DISCRIMINATOR));
  });
});
