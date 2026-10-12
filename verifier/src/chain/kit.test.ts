// kitChainReader over a fake kit RPC (no network).
import { type Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { OTHER_ADDRESS } from '../test-fixtures.ts';
import { kitChainReader } from './kit.ts';

type FakeRpc = Parameters<typeof kitChainReader>[0];

function rpcReturning(value: unknown): { rpc: FakeRpc; asked: Address[] } {
  const asked: Address[] = [];
  const rpc = {
    getAccountInfo: (at: Address) => {
      asked.push(at);
      return { send: async () => ({ value }) };
    },
  } as unknown as FakeRpc;
  return { rpc, asked };
}

describe('kitChainReader', () => {
  it('returns_null_for_an_account_that_does_not_exist', async () => {
    const { rpc } = rpcReturning(null);
    expect(await kitChainReader(rpc).account(OTHER_ADDRESS)).toBeNull();
  });

  it('returns_owner_and_decoded_data_of_an_existing_account', async () => {
    const data = Uint8Array.of(1, 2, 3, 250);
    const { rpc, asked } = rpcReturning({
      owner: OTHER_ADDRESS,
      lamports: 1n,
      data: [Buffer.from(data).toString('base64'), 'base64'],
    });
    const account = await kitChainReader(rpc).account(OTHER_ADDRESS);
    expect(asked).toEqual([OTHER_ADDRESS]);
    expect(account?.owner).toBe(OTHER_ADDRESS);
    expect(account?.data).toEqual(data);
  });
});

describe('kitChainReader failures', () => {
  it('turns_a_transport_error_into_fetch_failed_without_the_rpc_message', async () => {
    const rpc = {
      getAccountInfo: () => ({
        send: async () => {
          throw new Error('ECONNREFUSED secret-host');
        },
      }),
    } as unknown as FakeRpc;
    const failure = await kitChainReader(rpc)
      .account(OTHER_ADDRESS)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({ code: 'fetch_failed' });
    expect((failure as Error).message).not.toContain('secret-host');
  });
});
