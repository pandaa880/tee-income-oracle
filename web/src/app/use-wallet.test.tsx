import { renderHook } from '@testing-library/react';
import { generateKeyPairSigner } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { useWallet } from './use-wallet.ts';
import { fakeChain, fakeDeps } from '../test-support/fakes.ts';

async function deps() {
  const key = await generateKeyPairSigner();
  return fakeDeps(
    { address: key.address, signIntent: async () => new Uint8Array(64) as never, signer: key },
    fakeChain(new Map()),
  );
}

describe('useWallet', () => {
  it('returns the address of the deps signer', async () => {
    const d = await deps();
    const { result } = renderHook(() => useWallet(d));
    expect(result.current).toEqual({ address: d.signer.address });
  });
});
