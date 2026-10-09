// @vitest-environment node
import { type Address } from '@solana/kit';
import { DEMO_POOL_PROGRAM_ADDRESS } from '@tio/demo-pool-client';
import { ORACLE_PROGRAM_ID, SAS_PROGRAM_ID } from '@tio/oracle-client/attest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChain } from './rpc.ts';
import { bodyOf } from '../test-support/sse.ts';
import {
  ADMIN,
  entryBytes,
  loanBytes,
  OTHER,
  payloadBytes,
  POOL_0,
  poolBytes,
  sasAccountBytes,
  toBase64,
} from '../test-support/fixtures.ts';

const RPC_URL = 'https://rpc.test';
const signal = () => new AbortController().signal;
type FetchFn = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
type FakeAccount = { owner: Address; data: Uint8Array } | null;

const rpcJson = (id: unknown, result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const wireAccount = (account: FakeAccount) =>
  account === null
    ? null
    : {
        data: [toBase64(account.data), 'base64'],
        executable: false,
        lamports: 1_000_000,
        owner: account.owner,
        rentEpoch: 0,
        space: account.data.length,
      };

/** Answers the JSON-RPC methods the adapter may use, from a map of accounts. */
function rpcHandler(accounts: Map<string, FakeAccount>): FetchFn {
  return async (_, init) => {
    const body = JSON.parse(bodyOf(init)) as {
      id: unknown;
      method: string;
      params: unknown[];
    };
    const context = { slot: 1 };
    if (body.method === 'getMultipleAccounts') {
      const keys = body.params[0] as string[];
      return rpcJson(body.id, {
        context,
        value: keys.map((k) => wireAccount(accounts.get(k) ?? null)),
      });
    }
    if (body.method === 'getAccountInfo') {
      return rpcJson(body.id, {
        context,
        value: wireAccount(accounts.get(String(body.params[0])) ?? null),
      });
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  };
}

function stubFetch(handler: FetchFn) {
  const fetchMock = vi.fn<FetchFn>(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('accounts', () => {
  const attestationAddr = ADMIN;
  const sas = sasAccountBytes({ wallet: ADMIN, payload: payloadBytes({ tier: 2 }) });

  it('decodes each account by owner into a tagged value and keeps the request order', async () => {
    const store = new Map<string, FakeAccount>([
      [attestationAddr, { owner: SAS_PROGRAM_ID, data: sas }],
      [OTHER, { owner: ORACLE_PROGRAM_ID, data: entryBytes({ measurementId: 3 }) }],
      [POOL_0, { owner: DEMO_POOL_PROGRAM_ADDRESS, data: poolBytes() }],
    ]);
    stubFetch(rpcHandler(store));
    const result = await createChain(RPC_URL).accounts([POOL_0, attestationAddr, OTHER], signal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [pool, attestation, entry] = result.value;
    expect(pool).toMatchObject({
      kind: 'pool',
      pool: { poolId: 0, params: { maxAgeSecs: 2_592_000 } },
    });
    expect(attestation).toMatchObject({
      kind: 'attestation',
      attestation: { nonce: ADMIN, payload: payloadBytes({ tier: 2 }) },
    });
    expect(entry).toMatchObject({ kind: 'enclave_entry', entry: { measurementId: 3 } });
  });

  it('decodes a demo-pool Loan account', async () => {
    stubFetch(
      rpcHandler(
        new Map([[OTHER, { owner: DEMO_POOL_PROGRAM_ADDRESS, data: loanBytes(ADMIN, 7n) }]]),
      ),
    );
    const result = await createChain(RPC_URL).accounts([OTHER], signal());
    expect(result).toMatchObject({
      ok: true,
      value: [{ kind: 'loan', loan: { amount: 7n, borrower: ADMIN } }],
    });
  });

  it('returns null for an account that does not exist', async () => {
    stubFetch(rpcHandler(new Map()));
    expect(await createChain(RPC_URL).accounts([ADMIN, OTHER], signal())).toEqual({
      ok: true,
      value: [null, null],
    });
  });

  it.each([
    [
      'a SAS account of the wrong length',
      () => ({ owner: SAS_PROGRAM_ID, data: sas.slice(0, 255) }),
    ],
    [
      'a SAS account with the wrong discriminator',
      () => ({ owner: SAS_PROGRAM_ID, data: Uint8Array.from(sas, (b, i) => (i === 0 ? 1 : b)) }),
    ],
    [
      'an enclave entry of the wrong length',
      () => ({ owner: ORACLE_PROGRAM_ID, data: entryBytes().slice(1) }),
    ],
    [
      'an enclave entry with the wrong discriminator',
      () => ({
        owner: ORACLE_PROGRAM_ID,
        data: Uint8Array.from(entryBytes(), (b, i) => (i === 0 ? b ^ 0xff : b)),
      }),
    ],
    [
      'a pool of the wrong length',
      () => ({ owner: DEMO_POOL_PROGRAM_ADDRESS, data: poolBytes().slice(0, 100) }),
    ],
    [
      'a demo-pool account with an unknown discriminator',
      () => ({ owner: DEMO_POOL_PROGRAM_ADDRESS, data: new Uint8Array(240) }),
    ],
    [
      'an account owned by a program we do not read',
      () => ({ owner: ADMIN, data: new Uint8Array(10) }),
    ],
  ])('is a protocol_error for %s, never a throw', async (_, make) => {
    stubFetch(rpcHandler(new Map([[OTHER, make()]])));
    expect(await createChain(RPC_URL).accounts([OTHER], signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });
});

describe('rate limiting and failures', () => {
  it('retries a 429 with 250 ms then 500 ms backoff and gives rpc_busy after three tries', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(async () => new Response('', { status: 429 }));
    const pending = createChain(RPC_URL).accounts([OTHER], signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'rpc_busy' } });
  });

  it('stops backing off and is cancelled when the signal aborts during the wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = stubFetch(async () => new Response('', { status: 429 }));
    const pending = createChain(RPC_URL).accounts([OTHER], controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('succeeds when a retry gets through', async () => {
    vi.useFakeTimers();
    const handler = rpcHandler(new Map());
    let calls = 0;
    stubFetch(async (input, init) =>
      ++calls === 1 ? new Response('', { status: 429 }) : handler(input, init),
    );
    const pending = createChain(RPC_URL).accounts([OTHER], signal());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ ok: true, value: [null] });
    expect(calls).toBe(2);
  });

  it('is a network error for a server error or a rejected fetch', async () => {
    stubFetch(async () => new Response('boom', { status: 500 }));
    expect(await createChain(RPC_URL).accounts([OTHER], signal())).toMatchObject({
      ok: false,
      error: { code: 'network' },
    });
    stubFetch(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await createChain(RPC_URL).accounts([OTHER], signal())).toMatchObject({
      ok: false,
      error: { code: 'network' },
    });
  });

  it('is cancelled when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(async (_, init) => {
      if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError');
      return rpcHandler(new Map())(_, init);
    });
    expect(await createChain(RPC_URL).accounts([OTHER], controller.signal)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });
});

const statusReply = (value: unknown) =>
  stubFetch(async (_, init) => {
    const { id } = JSON.parse(bodyOf(init)) as { id: unknown };
    return rpcJson(id, { context: { slot: 1 }, value: [value] });
  });

describe('latestBlockhash and signatureStatus', () => {
  const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';

  it('returns the blockhash with a bigint last valid height', async () => {
    stubFetch(async (_, init) => {
      const { id } = JSON.parse(bodyOf(init)) as { id: unknown };
      return rpcJson(id, {
        context: { slot: 1 },
        value: { blockhash: BLOCKHASH, lastValidBlockHeight: 4242 },
      });
    });
    expect(await createChain(RPC_URL).latestBlockhash(signal())).toEqual({
      ok: true,
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 4242n },
    });
  });

  it('is null for a signature the node does not know', async () => {
    statusReply(null);
    expect(await createChain(RPC_URL).signatureStatus('sig', signal())).toEqual({
      ok: true,
      value: null,
    });
  });

  it('returns the confirmation status with a null err', async () => {
    statusReply({ slot: 5, confirmations: 3, err: null, confirmationStatus: 'confirmed' });
    expect(await createChain(RPC_URL).signatureStatus('sig', signal())).toEqual({
      ok: true,
      value: { confirmationStatus: 'confirmed', err: null },
    });
  });

  it('returns a failed status with its err', async () => {
    statusReply({
      slot: 5,
      confirmations: null,
      err: { InstructionError: [1, { Custom: 6008 }] },
      confirmationStatus: 'finalized',
    });
    expect(await createChain(RPC_URL).signatureStatus('sig', signal())).toMatchObject({
      ok: true,
      value: { confirmationStatus: 'finalized', err: { InstructionError: [1, { Custom: 6008 }] } },
    });
  });
});
