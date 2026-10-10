import { renderHook, waitFor } from '@testing-library/react';
import { generateKeyPairSigner, type Address } from '@solana/kit';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress, parseSasAttestation, SAS_PROGRAM_ID } from '@tio/oracle-client/attest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCredential } from './use-credential.ts';
import type { BorrowerSigner } from '../domain/ports.ts';
import type { ChainAccount } from '../domain/types.ts';
import { fail, fakeChain, fakeDeps } from '../test-support/fakes.ts';
import {
  CREDENTIAL,
  entry,
  NOW,
  OTHER,
  POLICY_HASH,
  pool,
  POOL_0,
  payloadBytes,
  SAS_SIGNER,
  SCHEMA,
  sasAccountBytes,
} from '../test-support/fixtures.ts';
import { queryWrapper } from '../test-support/query.tsx';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Number(NOW) * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

async function world(
  options: { attestation?: boolean; signer?: Address; policy?: Uint8Array } = {},
) {
  const key = await generateKeyPairSigner();
  const wallet = key.address;
  const store = new Map<Address, ChainAccount>();
  store.set(POOL_0, { kind: 'pool', pool: pool({ policyHash: options.policy ?? POLICY_HASH }) });
  store.set((await findEnclaveEntryPda({ measurementId: 0 }))[0], {
    kind: 'enclave_entry',
    entry: entry(),
  });
  if (options.attestation !== false) {
    const bytes = sasAccountBytes({ wallet, signer: options.signer ?? SAS_SIGNER });
    store.set(await attestationAddress(CREDENTIAL, SCHEMA, wallet), {
      kind: 'attestation',
      attestation: parseSasAttestation(SAS_PROGRAM_ID, bytes),
    });
  }
  const signer: BorrowerSigner = {
    address: wallet,
    signIntent: async () => new Uint8Array(64) as never,
    signer: key,
  };
  return { wallet, deps: fakeDeps(signer, fakeChain(store)) };
}

describe('useCredential', () => {
  it('reports valid for a fresh attestation from the oracle signer', async () => {
    const { wallet, deps } = await world();
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBe('valid'));
  });

  it('reports none when the wallet has no attestation', async () => {
    const { wallet, deps } = await world({ attestation: false });
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBe('none'));
  });

  it('reports foreign_signer for an attestation signed by someone else', async () => {
    const { wallet, deps } = await world({ signer: OTHER });
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBe('foreign_signer'));
  });

  it('reports policy_mismatch when the lender changed its policy hash', async () => {
    const { wallet, deps } = await world({ policy: new Uint8Array(32).fill(0x99) });
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBe('policy_mismatch'));
  });

  it('reads the registry entry of the payload measurement id, not a default one', async () => {
    const key = await generateKeyPairSigner();
    const store = new Map<Address, ChainAccount>([
      [POOL_0, { kind: 'pool', pool: pool() }],
      // Only entry 1 exists: reading entry 0 would give enclave_revoked/not_approved.
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
    const signer = {
      address: key.address,
      signIntent: async () => new Uint8Array(64) as never,
      signer: key,
    };
    const deps = fakeDeps(signer, fakeChain(store));
    const { result } = renderHook(() => useCredential(key.address, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBe('valid'));
  });

  it('surfaces a chain error as the query error (the AppError object), not as a status', async () => {
    const { wallet, deps } = await world();
    vi.mocked(deps.chain.accounts).mockResolvedValue(fail({ code: 'rpc_busy' }));
    const { result } = renderHook(() => useCredential(wallet, POOL_0, deps), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: 'rpc_busy' });
    expect(result.current.data).toBeUndefined();
  });
});
