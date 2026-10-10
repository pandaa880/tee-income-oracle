import { act, renderHook } from '@testing-library/react';
import {
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signBytes,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import {
  findLoanPda,
  getBorrowInstructionDataDecoder,
  getLoanDecoder,
} from '@tio/demo-pool-client';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress, parseSasAttestation, SAS_PROGRAM_ID } from '@tio/oracle-client/attest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { checkLoanTx, verifyBorrowerSignature } from '../../../gateway/src/loan-relay.ts';
import { useLoan } from './use-loan.ts';
import type { ChainPort, GatewayPort, RelayPort } from '../domain/ports.ts';
import type { ChainAccount } from '../domain/types.ts';
import { fail, fakeChain, fakeDeps, fakeGateway, INFO, ok, SIG } from '../test-support/fakes.ts';
import {
  CREDENTIAL,
  entry,
  LOAN_DEPLOYMENT,
  loanBytes,
  payloadBytes,
  POOL_0,
  POOL_1,
  SCHEMA,
  sasAccountBytes,
} from '../test-support/fixtures.ts';
import { queryWrapper } from '../test-support/query.tsx';

let key: KeyPairSigner;
/** Stands in for the gateway's relayer: a real key, so its signature over the message verifies. */
let relayer: KeyPairSigner;
beforeAll(async () => {
  key = await generateKeyPairSigner();
  relayer = await generateKeyPairSigner();
});

/** What the real relayer's signature (= the transaction id) is: Ed25519 over the message bytes. */
async function relayerSignature(txB64: string): Promise<string> {
  const wire = Uint8Array.from(getBase64Encoder().encode(txB64));
  const { messageBytes } = getTransactionDecoder().decode(wire);
  return getBase58Decoder().decode(await signBytes(relayer.keyPair.privateKey, messageBytes));
}

/**
 * A chain with the borrower's attestation (measurement id 1) and its registry entry. The default
 * relay plays the cluster: a borrow creates the Loan account, a repay closes it.
 */
async function setup(
  overrides: { relay?: RelayPort; chain?: (c: ChainPort) => void; loanAppears?: boolean } = {},
) {
  const [loanAddress] = await findLoanPda({ pool: POOL_0, borrower: key.address });
  const store = new Map<Address, ChainAccount>([
    [
      (await findEnclaveEntryPda({ measurementId: 1 }))[0],
      { kind: 'enclave_entry', entry: entry({ measurementId: 1 }) },
    ],
    [
      await attestationAddress(CREDENTIAL, SCHEMA, key.address),
      {
        kind: 'attestation',
        attestation: parseSasAttestation(
          SAS_PROGRAM_ID,
          sasAccountBytes({ wallet: key.address, payload: payloadBytes({ measurementId: 1 }) }),
        ),
      },
    ],
  ]);
  const chain = fakeChain(store);
  overrides.chain?.(chain);
  const relay: RelayPort = overrides.relay ?? {
    relay: vi.fn<RelayPort['relay']>(async (txB64) => {
      const shape = await checkLoanTx(
        Uint8Array.from(getBase64Encoder().encode(txB64)),
        relayer.address,
        {
          ...LOAN_DEPLOYMENT,
          pools: [POOL_0, POOL_1],
        },
      );
      if (shape.ok && shape.value.kind === 'borrow' && overrides.loanAppears !== false) {
        const compiled = getCompiledTransactionMessageDecoder().decode(shape.value.tx.messageBytes);
        const data = decompileTransactionMessage(compiled).instructions[1]?.data;
        const amount = data ? getBorrowInstructionDataDecoder().decode(data).amount : 0n;
        store.set(loanAddress, {
          kind: 'loan',
          loan: getLoanDecoder().decode(loanBytes(key.address, amount)),
        });
      }
      if (shape.ok && shape.value.kind === 'repay') store.delete(loanAddress);
      return ok(await relayerSignature(txB64));
    }),
  };
  const deps = fakeDeps(
    { address: key.address, signIntent: async () => new Uint8Array(64) as never, signer: key },
    chain,
    {
      relay,
      gateway: fakeGateway({
        info: vi.fn<GatewayPort['info']>(async () => ok({ ...INFO, relayer: relayer.address })),
      }),
    },
  );
  return { deps, relay, chain, store, loanAddress };
}

const GATEWAY_DEPLOYMENT = { ...LOAN_DEPLOYMENT, pools: [POOL_0, POOL_1] };
const sentBytes = (relay: RelayPort): Uint8Array => {
  const b64 = vi.mocked(relay.relay).mock.calls[0]?.[0] ?? '';
  return Uint8Array.from(getBase64Encoder().encode(b64));
};

describe('useLoan borrow', () => {
  it('builds, signs and relays a transaction the relayer accepts, then resolves the signature', async () => {
    const { deps, relay } = await setup();
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    let signature: unknown;
    await act(async () => {
      signature = await result.current.borrow.mutateAsync(2_000_000n);
    });
    expect(signature).toBe(await relayerSignature(vi.mocked(relay.relay).mock.calls[0]?.[0] ?? ''));
    const shape = await checkLoanTx(sentBytes(relay), relayer.address, GATEWAY_DEPLOYMENT);
    expect(shape).toMatchObject({ ok: true, value: { kind: 'borrow', borrower: key.address } });
    expect(shape.ok && (await verifyBorrowerSignature(shape.value))).toBe(true);
    if (!shape.ok) return;
    const ix = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(shape.value.tx.messageBytes),
    ).instructions[1];
    expect(ix?.data && getBorrowInstructionDataDecoder().decode(ix.data).amount).toBe(2_000_000n);
    // Account 8 of `borrow` is the registry entry of the attestation's enclave build (id 1, not
    // the PDA default 0).
    expect(ix?.accounts?.[8]?.address).toBe((await findEnclaveEntryPda({ measurementId: 1 }))[0]);
  });

  it('takes the relayer from /v1/info and a fresh blockhash from the chain', async () => {
    const { deps } = await setup();
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    await act(async () => {
      await result.current.borrow.mutateAsync(1n);
    });
    expect(deps.gateway.info).toHaveBeenCalled();
    expect(deps.chain.latestBlockhash).toHaveBeenCalled();
  });

  it('polls for confirmation after the relay answers', async () => {
    const { deps, chain, relay } = await setup();
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    await act(async () => {
      await result.current.borrow.mutateAsync(1n);
    });
    const sent = vi.mocked(relay.relay).mock.calls[0]?.[0] ?? '';
    expect(chain.signatureStatus).toHaveBeenCalledWith(
      await relayerSignature(sent),
      expect.any(AbortSignal),
    );
  });

  it('rejects with the typed relay error and never polls when the relayer refuses', async () => {
    const relay: RelayPort = {
      relay: vi.fn<RelayPort['relay']>(async () => fail({ code: 'bad_transaction', rule: 7 })),
    };
    const { deps, chain } = await setup({ relay });
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    await act(async () => {
      await expect(result.current.borrow.mutateAsync(1n)).rejects.toMatchObject({
        code: 'bad_transaction',
        rule: 7,
      });
    });
    expect(chain.signatureStatus).not.toHaveBeenCalled();
  });

  it('rejects with tx_failed when the relayed transaction fails on chain', async () => {
    const { deps } = await setup({
      chain: (chain) => {
        vi.mocked(chain.signatureStatus).mockResolvedValue(
          ok({ confirmationStatus: 'confirmed', err: { InstructionError: [1, { Custom: 6008 }] } }),
        );
      },
    });
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    await act(async () => {
      await expect(result.current.borrow.mutateAsync(1n)).rejects.toMatchObject({
        code: 'tx_failed',
      });
    });
  });
});

describe('useLoan does not take the relayer at its word', () => {
  it('rejects a confirmed borrow when no Loan account appears for the borrower', async () => {
    const { deps } = await setup({ loanAppears: false });
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    await act(async () => {
      await expect(result.current.borrow.mutateAsync(1n)).rejects.toMatchObject({
        code: 'protocol_error',
      });
    });
  });

  it('rejects a confirmed repay when the Loan account is still there', async () => {
    const { deps, store, loanAddress } = await setup({
      relay: { relay: vi.fn<RelayPort['relay']>(async () => ok(SIG)) },
    });
    store.set(loanAddress, { kind: 'loan', loan: getLoanDecoder().decode(loanBytes(key.address)) });
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    await act(async () => {
      await expect(result.current.repay.mutateAsync()).rejects.toMatchObject({
        code: 'protocol_error',
      });
    });
  });
});

describe('useLoan readback and cancellation', () => {
  it('retries the Loan readback when the first read comes from a node a slot behind', async () => {
    const { deps, chain, loanAddress } = await setup();
    const real = vi.mocked(chain.accounts).getMockImplementation();
    let loanReads = 0;
    vi.mocked(chain.accounts).mockImplementation(async (addresses, signal) => {
      if (addresses[0] === loanAddress && ++loanReads === 1) return ok([null]);
      return real ? real(addresses, signal) : ok([]);
    });
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    await act(async () => {
      await expect(result.current.borrow.mutateAsync(5n)).resolves.toMatch(
        /^[1-9A-HJ-NP-Za-km-z]{64,88}$/,
      );
    });
    expect(loanReads).toBeGreaterThanOrEqual(2);
  });

  it('refuses to borrow while a loan is open, before relaying anything', async () => {
    const { deps, store, loanAddress } = await setup({
      relay: { relay: vi.fn<RelayPort['relay']>(async () => ok(SIG)) },
    });
    store.set(loanAddress, {
      kind: 'loan',
      loan: getLoanDecoder().decode(loanBytes(key.address, 9n)),
    });
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    await act(async () => {
      await expect(result.current.borrow.mutateAsync(5n)).rejects.toMatchObject({
        code: 'loan_exists',
      });
    });
  });

  it('aborts the relay request when the component unmounts', async () => {
    let seen: AbortSignal | undefined;
    const { promise: never } = Promise.withResolvers<never>();
    const { deps } = await setup({
      relay: {
        relay: vi.fn<RelayPort['relay']>(async (_tx, signal) => {
          seen = signal;
          return never;
        }),
      },
    });
    const { result, unmount } = renderHook(() => useLoan(POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    act(() => {
      result.current.borrow.mutate(1n);
    });
    await vi.waitFor(() => expect(seen).toBeDefined());
    unmount();
    expect(seen?.aborted).toBe(true);
  });
});

describe('useLoan binds the confirmation to its own transaction', () => {
  it('rejects an unrelated confirmed signature even when a stale read hides an existing loan', async () => {
    const { deps, chain, store, loanAddress } = await setup({
      relay: { relay: vi.fn<RelayPort['relay']>(async () => ok(SIG)) },
    });
    // The loan exists, but the pre-read hits a node a slot behind and sees nothing.
    store.set(loanAddress, {
      kind: 'loan',
      loan: getLoanDecoder().decode(loanBytes(key.address, 5n)),
    });
    const real = vi.mocked(chain.accounts).getMockImplementation();
    let loanReads = 0;
    vi.mocked(chain.accounts).mockImplementation(async (addresses, signal) => {
      if (addresses[0] === loanAddress && ++loanReads === 1) return ok([null]);
      return real ? real(addresses, signal) : ok([]);
    });
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    await act(async () => {
      await expect(result.current.borrow.mutateAsync(5n)).rejects.toMatchObject({
        code: 'protocol_error',
      });
    });
    expect(chain.signatureStatus).not.toHaveBeenCalled();
  });
});

describe('useLoan error typing', () => {
  it('maps a stray throw (kit refusing relayer == borrower) to protocol_error', async () => {
    const { deps } = await setup();
    vi.mocked(deps.gateway.info).mockResolvedValue(ok({ ...INFO, relayer: key.address }));
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    await act(async () => {
      await expect(result.current.borrow.mutateAsync(1n)).rejects.toEqual({
        code: 'protocol_error',
      });
    });
  });
});

describe('useLoan repay', () => {
  it('relays a repay transaction the relayer accepts and resolves the signature', async () => {
    const { deps, relay, store, loanAddress } = await setup();
    store.set(loanAddress, { kind: 'loan', loan: getLoanDecoder().decode(loanBytes(key.address)) });
    const { result } = renderHook(() => useLoan(POOL_0, deps), { wrapper: queryWrapper() });
    let signature: unknown;
    await act(async () => {
      signature = await result.current.repay.mutateAsync();
    });
    expect(signature).toBe(await relayerSignature(vi.mocked(relay.relay).mock.calls[0]?.[0] ?? ''));
    const shape = await checkLoanTx(sentBytes(relay), relayer.address, GATEWAY_DEPLOYMENT);
    expect(shape).toMatchObject({ ok: true, value: { kind: 'repay', borrower: key.address } });
  });
});
