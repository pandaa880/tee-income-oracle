/**
 * Reads the served pools' SAS credential and schema once at boot (FORMATS §14). `create_pool`
 * fixes both and `update_pool` can't change them, so the loan relay can pin each borrower's
 * attestation to its pool's seeds without a read per transaction. A listed address that isn't a
 * demo-pool `Pool` stops the gateway at boot, like a missing registry entry.
 */
import type { Address } from '@solana/kit';
import {
  DEMO_POOL_PROGRAM_ADDRESS,
  POOL_DISCRIMINATOR,
  type Pool,
  getPoolDecoder,
  getPoolSize,
} from '@tio/demo-pool-client';

import type { Chain, RawAccount } from './chain.ts';
import { ConfigError } from './config.ts';
import type { LoanPool } from './loan-relay.ts';

/** The pool held by a fetched account, or undefined if it isn't a demo-pool `Pool`. */
export function poolFromAccount(account: RawAccount | null): Pool | undefined {
  if (account === null || account.owner !== DEMO_POOL_PROGRAM_ADDRESS) return undefined;
  // Checked decode (length + discriminator): the generated decoder checks neither.
  if (account.data.length !== getPoolSize()) return undefined;
  if (!POOL_DISCRIMINATOR.every((byte, i) => account.data[i] === byte)) return undefined;
  return getPoolDecoder().decode(account.data);
}

/** @throws ConfigError naming the first listed address that holds no `Pool`. */
export async function readLoanPools(
  chain: Pick<Chain, 'account'>,
  addresses: readonly Address[],
): Promise<LoanPool[]> {
  return Promise.all(
    addresses.map(async (address) => {
      const pool = poolFromAccount(await chain.account(address));
      if (pool === undefined) {
        throw new ConfigError(`deployment pool ${address} is not a demo-pool Pool account`);
      }
      return { address, credential: pool.credential, schema: pool.schema };
    }),
  );
}
