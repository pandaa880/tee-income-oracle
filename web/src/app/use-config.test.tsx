import { renderHook } from '@testing-library/react';
import { generateKeyPairSigner } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { useConfig } from './use-config.ts';
import { CONFIG, fakeChain, fakeDeps } from '../test-support/fakes.ts';

async function deps() {
  const key = await generateKeyPairSigner();
  return fakeDeps(
    { address: key.address, signIntent: async () => new Uint8Array(64) as never, signer: key },
    fakeChain(new Map()),
  );
}

describe('useConfig', () => {
  it('returns the deps config', async () => {
    const d = await deps();
    const { result } = renderHook(() => useConfig(d));
    expect(result.current).toBe(CONFIG);
  });
});
