// @vitest-environment node
import { type Address, generateKeyPairSigner, getBase58Decoder } from '@solana/kit';
import { DEMO_POOL_PROGRAM_ADDRESS, LOAN_DISCRIMINATOR } from '@tio/demo-pool-client';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
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
  POOL_1,
  poolBytes,
  RELAYER,
  sasAccountBytes,
  toBase64,
  tokenAccountBytes,
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

  it('decodes an SPL token account (the pool vault) with its amount', async () => {
    stubFetch(
      rpcHandler(
        new Map([
          [
            OTHER,
            { owner: TOKEN_PROGRAM_ADDRESS, data: tokenAccountBytes({ amount: 42_000_000n }) },
          ],
        ]),
      ),
    );
    const result = await createChain(RPC_URL).accounts([OTHER], signal());
    expect(result).toMatchObject({
      ok: true,
      value: [{ kind: 'token', token: { amount: 42_000_000n } }],
    });
  });

  it('is a protocol_error for a token-program account of the wrong length', async () => {
    const data = tokenAccountBytes({ amount: 1n });
    stubFetch(
      rpcHandler(
        new Map([
          [OTHER, { owner: TOKEN_PROGRAM_ADDRESS, data: data.slice(0, 82) }],
          [ADMIN, { owner: TOKEN_PROGRAM_ADDRESS, data }],
        ]),
      ),
    );
    expect(await createChain(RPC_URL).accounts([ADMIN, OTHER], signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
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

  it.each([
    [-32005, 'rpc_busy'],
    [-32602, 'network'],
  ])('maps a JSON-RPC error %i to %s, not protocol_error', async (code, expected) => {
    stubFetch(async (_, init) => {
      const { id } = JSON.parse(bodyOf(init)) as { id: unknown };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'm' } }), {
        status: 200,
      });
    });
    expect(await createChain(RPC_URL).accounts([OTHER], signal())).toMatchObject({
      ok: false,
      error: { code: expected },
    });
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

const many = async (count: number): Promise<Address[]> =>
  Promise.all(Array.from({ length: count }, async () => (await generateKeyPairSigner()).address));

const keysOf = (init: RequestInit | undefined): string[] =>
  (JSON.parse(bodyOf(init)) as { params: [string[]] }).params[0];

/** Answers getMultipleAccounts with `extra` more (or, negative, fewer) entries than keys sent. */
const lengthOff =
  (extra: number): FetchFn =>
  async (_, init) => {
    const body = JSON.parse(bodyOf(init)) as { id: unknown; params: [string[]] };
    const count = body.params[0].length + extra;
    return rpcJson(body.id, {
      context: { slot: 1 },
      value: Array.from({ length: count }, () => null),
    });
  };

describe('accounts reply length', () => {
  it('is a protocol_error when the reply has fewer accounts than keys', async () => {
    stubFetch(lengthOff(-1));
    expect(await createChain(RPC_URL).accounts(await many(3), signal())).toEqual({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });

  it('is a protocol_error when the reply has more accounts than keys', async () => {
    stubFetch(lengthOff(1));
    expect(await createChain(RPC_URL).accounts(await many(3), signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });

  it('is a protocol_error when only a later chunk comes back short', async () => {
    let calls = 0;
    const exact = lengthOff(0);
    const short = lengthOff(-1);
    stubFetch(async (input, init) => (++calls === 2 ? short(input, init) : exact(input, init)));
    expect(await createChain(RPC_URL).accounts(await many(150), signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });
});

describe('accounts with more than 100 addresses', () => {
  it('splits 150 addresses into getMultipleAccounts calls of 100 and 50', async () => {
    const addresses = await many(150);
    const handler = rpcHandler(new Map());
    const fetchMock = stubFetch(handler);
    const result = await createChain(RPC_URL).accounts(addresses, signal());
    expect(result.ok && result.value).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sent = fetchMock.mock.calls.map(([, init]) => keysOf(init));
    expect(sent.map((keys) => keys.length)).toEqual([100, 50]);
    expect(sent.flat()).toEqual(addresses);
  });

  it('sends exactly 100 addresses in one call', async () => {
    const fetchMock = stubFetch(rpcHandler(new Map()));
    await createChain(RPC_URL).accounts(await many(100), signal());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the accounts in request order across the chunks', async () => {
    const addresses = await many(150);
    const at = (i: number): Address => {
      const found = addresses[i];
      if (found === undefined) throw new Error('missing address');
      return found;
    };
    const store = new Map<string, FakeAccount>([
      [at(0), { owner: DEMO_POOL_PROGRAM_ADDRESS, data: loanBytes(ADMIN, 1n) }],
      [at(99), { owner: DEMO_POOL_PROGRAM_ADDRESS, data: loanBytes(ADMIN, 2n) }],
      [at(100), { owner: DEMO_POOL_PROGRAM_ADDRESS, data: loanBytes(ADMIN, 3n) }],
      [at(149), { owner: DEMO_POOL_PROGRAM_ADDRESS, data: loanBytes(ADMIN, 4n) }],
    ]);
    stubFetch(rpcHandler(store));
    const result = await createChain(RPC_URL).accounts(addresses, signal());
    if (!result.ok) throw new Error('expected ok');
    const amounts = result.value.map((a) => (a?.kind === 'loan' ? a.loan.amount : null));
    expect(amounts[0]).toBe(1n);
    expect(amounts[99]).toBe(2n);
    expect(amounts[100]).toBe(3n);
    expect(amounts[149]).toBe(4n);
    expect(amounts.filter((a) => a !== null)).toHaveLength(4);
  });

  it('fails the whole call when the second chunk fails', async () => {
    const handler = rpcHandler(new Map());
    let calls = 0;
    stubFetch(async (input, init) =>
      ++calls === 2 ? new Response('boom', { status: 500 }) : handler(input, init),
    );
    expect(await createChain(RPC_URL).accounts(await many(150), signal())).toMatchObject({
      ok: false,
      error: { code: 'network' },
    });
  });
});

const wireRow = (pubkey: string, account: FakeAccount) => ({
  pubkey,
  account: wireAccount(account),
});
const loanAccount = (amount: bigint, pool: Address = POOL_0): FakeAccount => ({
  owner: DEMO_POOL_PROGRAM_ADDRESS,
  data: loanBytes(ADMIN, amount, { pool }),
});

/** Answers a getProgramAccounts call with `rows` as the plain-array result. */
const stubRows = (rows: unknown) =>
  stubFetch(async (_, init) => {
    const { id } = JSON.parse(bodyOf(init)) as { id: unknown };
    return rpcJson(id, rows);
  });

describe('poolLoans', () => {
  const DISCRIMINATOR_B58 = getBase58Decoder().decode(Uint8Array.from(LOAN_DISCRIMINATOR));
  const LOAN_A = OTHER;
  const LOAN_B = RELAYER;

  it('sends one getProgramAccounts with the Loan size, discriminator and pool filters', async () => {
    const fetchMock = stubRows([]);
    await createChain(RPC_URL).poolLoans(POOL_0, signal());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(bodyOf(fetchMock.mock.calls[0]?.[1])) as {
      method: string;
      params: unknown[];
    };
    expect(body.method).toBe('getProgramAccounts');
    expect(body.params).toEqual([
      DEMO_POOL_PROGRAM_ADDRESS,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        filters: [
          { dataSize: 131 },
          { memcmp: { offset: 0, bytes: DISCRIMINATOR_B58, encoding: 'base58' } },
          { memcmp: { offset: 11, bytes: POOL_0, encoding: 'base58' } },
        ],
      },
    ]);
  });

  it('asks for the pool it was given', async () => {
    const fetchMock = stubRows([]);
    await createChain(RPC_URL).poolLoans(POOL_1, signal());
    const body = JSON.parse(bodyOf(fetchMock.mock.calls[0]?.[1])) as {
      params: [string, { filters: { memcmp?: { offset: number; bytes: string } }[] }];
    };
    expect(body.params[1].filters[2]?.memcmp).toMatchObject({ offset: 11, bytes: POOL_1 });
  });

  it('decodes each valid row into its address and Loan', async () => {
    stubRows([wireRow(LOAN_A, loanAccount(5n)), wireRow(LOAN_B, loanAccount(7n))]);
    const result = await createChain(RPC_URL).poolLoans(POOL_0, signal());
    expect(result).toMatchObject({
      ok: true,
      value: [
        { address: LOAN_A, loan: { amount: 5n, pool: POOL_0, borrower: ADMIN } },
        { address: LOAN_B, loan: { amount: 7n } },
      ],
    });
  });

  it('is an empty list for a pool without loans', async () => {
    stubRows([]);
    expect(await createChain(RPC_URL).poolLoans(POOL_0, signal())).toEqual({
      ok: true,
      value: [],
    });
  });

  it.each([
    [
      'an owner other than the demo-pool program',
      () => wireRow(LOAN_A, { owner: ADMIN, data: loanBytes(ADMIN, 1n) }),
    ],
    [
      'the wrong size',
      () =>
        wireRow(LOAN_A, {
          owner: DEMO_POOL_PROGRAM_ADDRESS,
          data: loanBytes(ADMIN, 1n).slice(0, 130),
        }),
    ],
    [
      'the wrong discriminator',
      () =>
        wireRow(LOAN_A, {
          owner: DEMO_POOL_PROGRAM_ADDRESS,
          data: Uint8Array.from(loanBytes(ADMIN, 1n), (b, i) => (i === 0 ? b ^ 0xff : b)),
        }),
    ],
    [
      'a Pool account instead of a Loan',
      () => wireRow(LOAN_A, { owner: DEMO_POOL_PROGRAM_ADDRESS, data: poolBytes() }),
    ],
    ['a loan of another pool', () => wireRow(LOAN_A, loanAccount(1n, POOL_1))],
    ['a pubkey that is not an address', () => wireRow('not-an-address', loanAccount(1n))],
    ['no account', () => ({ pubkey: LOAN_A, account: null })],
    ['a row without a pubkey', () => ({ account: wireAccount(loanAccount(1n)) })],
  ])('is a protocol_error for a row with %s', async (_, makeRow) => {
    stubRows([wireRow(LOAN_B, loanAccount(2n)), makeRow()]);
    expect(await createChain(RPC_URL).poolLoans(POOL_0, signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });

  it.each([
    ['an object instead of an array', {}],
    ['null', null],
    ['a context wrapper', { context: { slot: 1 }, value: [] }],
  ])('is a protocol_error when the result is %s', async (_, result) => {
    stubRows(result);
    expect(await createChain(RPC_URL).poolLoans(POOL_0, signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });

  it('backs off on a 429 and succeeds when the retry gets through', async () => {
    vi.useFakeTimers();
    let calls = 0;
    stubFetch(async (_, init) => {
      if (++calls === 1) return new Response('', { status: 429 });
      const { id } = JSON.parse(bodyOf(init)) as { id: unknown };
      return rpcJson(id, [wireRow(LOAN_A, loanAccount(5n))]);
    });
    const pending = createChain(RPC_URL).poolLoans(POOL_0, signal());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ ok: true, value: [{ address: LOAN_A }] });
    expect(calls).toBe(2);
  });

  it('gives rpc_busy after the backoffs run out', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(async () => new Response('', { status: 429 }));
    const pending = createChain(RPC_URL).poolLoans(POOL_0, signal());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'rpc_busy' } });
  });
});

describe('rawAccounts', () => {
  const entryData = entryBytes({ measurementId: 3 });

  it('returns the owner and the undecoded bytes of each account, in request order', async () => {
    const store = new Map<string, FakeAccount>([
      [OTHER, { owner: ORACLE_PROGRAM_ID, data: entryData }],
      [ADMIN, { owner: SAS_PROGRAM_ID, data: new Uint8Array([1, 2, 3]) }],
    ]);
    stubFetch(rpcHandler(store));
    const result = await createChain(RPC_URL).rawAccounts([ADMIN, OTHER], signal());
    if (!result.ok) throw new Error('expected ok');
    const [first, second] = result.value;
    expect(first?.owner).toBe(SAS_PROGRAM_ID);
    expect(Array.from(first?.data ?? [])).toEqual([1, 2, 3]);
    expect(second?.owner).toBe(ORACLE_PROGRAM_ID);
    expect(Array.from(second?.data ?? [])).toEqual(Array.from(entryData));
  });

  it('returns null for an account that does not exist', async () => {
    stubFetch(rpcHandler(new Map()));
    expect(await createChain(RPC_URL).rawAccounts([ADMIN, OTHER], signal())).toEqual({
      ok: true,
      value: [null, null],
    });
  });

  it('does not judge the bytes: a malformed account of an unknown owner is returned as is', async () => {
    stubFetch(rpcHandler(new Map([[OTHER, { owner: ADMIN, data: new Uint8Array([9]) }]])));
    const result = await createChain(RPC_URL).rawAccounts([OTHER], signal());
    expect(result).toMatchObject({ ok: true, value: [{ owner: ADMIN }] });
  });

  it('asks getMultipleAccounts for base64 data', async () => {
    const fetchMock = stubFetch(rpcHandler(new Map()));
    await createChain(RPC_URL).rawAccounts([OTHER], signal());
    const body = JSON.parse(bodyOf(fetchMock.mock.calls[0]?.[1])) as {
      method: string;
      params: [string[], { encoding: string }];
    };
    expect(body.method).toBe('getMultipleAccounts');
    expect(body.params[0]).toEqual([OTHER]);
    expect(body.params[1].encoding).toBe('base64');
  });

  it('is a protocol_error when the reply has a different number of accounts than keys', async () => {
    stubFetch(lengthOff(-1));
    expect(await createChain(RPC_URL).rawAccounts(await many(3), signal())).toMatchObject({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });

  it('splits 150 addresses into calls of 100 and 50, in order', async () => {
    const addresses = await many(150);
    const fetchMock = stubFetch(rpcHandler(new Map()));
    const result = await createChain(RPC_URL).rawAccounts(addresses, signal());
    expect(result.ok && result.value).toHaveLength(150);
    const sent = fetchMock.mock.calls.map(([, init]) => keysOf(init));
    expect(sent.map((keys) => keys.length)).toEqual([100, 50]);
    expect(sent.flat()).toEqual(addresses);
  });

  it('backs off a 429 and gives rpc_busy after three tries', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(async () => new Response('', { status: 429 }));
    const pending = createChain(RPC_URL).rawAccounts([OTHER], signal());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'rpc_busy' } });
  });

  it('succeeds when a retry after a 429 gets through', async () => {
    vi.useFakeTimers();
    const handler = rpcHandler(new Map());
    let calls = 0;
    stubFetch(async (input, init) =>
      ++calls === 1 ? new Response('', { status: 429 }) : handler(input, init),
    );
    const pending = createChain(RPC_URL).rawAccounts([OTHER], signal());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ ok: true, value: [null] });
  });

  it('is a network error for a server error', async () => {
    stubFetch(async () => new Response('boom', { status: 500 }));
    expect(await createChain(RPC_URL).rawAccounts([OTHER], signal())).toMatchObject({
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
    expect(await createChain(RPC_URL).rawAccounts([OTHER], controller.signal)).toMatchObject({
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
