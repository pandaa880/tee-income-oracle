import type { Address } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import type { AppError, ChainAccount, RawAccount } from '../domain/types.ts';
import { fail, fakeChain } from '../test-support/fakes.ts';
import { ADMIN, OTHER, POOL_0 } from '../test-support/fixtures.ts';
import { chainReader } from './verifier-chain.ts';

const signal = () => new AbortController().signal;
const ACCOUNT: RawAccount = { owner: OTHER, data: new Uint8Array([1, 2, 3]) };

const chainWith = (raw: Map<Address, RawAccount>) =>
  fakeChain(new Map<Address, ChainAccount>(), raw);

describe('chainReader', () => {
  it('returns the owner and bytes of the account', async () => {
    const reader = chainReader(chainWith(new Map([[ADMIN, ACCOUNT]])), signal());
    expect(await reader.account(ADMIN)).toEqual(ACCOUNT);
  });

  it('returns null for an account that does not exist', async () => {
    const reader = chainReader(chainWith(new Map()), signal());
    expect(await reader.account(POOL_0)).toBeNull();
  });

  it('reads one address per call, with the signal it was given', async () => {
    const chain = chainWith(new Map([[ADMIN, ACCOUNT]]));
    const controller = new AbortController();
    await chainReader(chain, controller.signal).account(ADMIN);
    expect(chain.rawAccounts).toHaveBeenCalledTimes(1);
    expect(chain.rawAccounts).toHaveBeenCalledWith([ADMIN], controller.signal);
  });

  it('reads the raw bytes, never the decoded accounts', async () => {
    const chain = chainWith(new Map([[ADMIN, ACCOUNT]]));
    await chainReader(chain, signal()).account(ADMIN);
    expect(chain.accounts).not.toHaveBeenCalled();
  });

  it('throws the AppError object itself when the read fails', async () => {
    const error: AppError = { code: 'rpc_busy' };
    const chain = chainWith(new Map());
    vi.mocked(chain.rawAccounts).mockResolvedValueOnce(fail(error));
    await expect(chainReader(chain, signal()).account(ADMIN)).rejects.toBe(error);
  });

  it('answers each address of several reads on its own', async () => {
    const reader = chainReader(chainWith(new Map([[ADMIN, ACCOUNT]])), signal());
    expect(await reader.account(ADMIN)).toEqual(ACCOUNT);
    expect(await reader.account(OTHER)).toBeNull();
  });
});
