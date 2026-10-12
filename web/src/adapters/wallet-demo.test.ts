// @vitest-environment node
import { getPublicKeyFromAddress, verifySignature } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { demoWallet } from './wallet-demo.ts';
import type { StoragePort } from '../domain/ports.ts';
import { memoryStorage } from '../test-support/fakes.ts';

const INTENT = [
  'tee-income-oracle: bind session',
  'session: 7c9e6679-7425-40de-944b-e07fc1f90ae7',
  'wallet: 3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND',
  `policy: ${'11'.repeat(32)}`,
  'expires: 1790000600',
].join('\n');
const signal = () => new AbortController().signal;

const brokenStorage: StoragePort = {
  get() {
    throw new Error('denied');
  },
  set() {
    throw new Error('denied');
  },
  remove() {
    throw new Error('denied');
  },
};

describe('demoWallet', () => {
  it('creates a wallet on first use and restores the same address from the same storage', async () => {
    const storage = memoryStorage();
    const first = await demoWallet(storage);
    const second = await demoWallet(storage);
    expect(second.address).toBe(first.address);
    expect(second.signer.address).toBe(first.address);
  });

  it('gives separate storages separate wallets', async () => {
    const a = await demoWallet(memoryStorage());
    const b = await demoWallet(memoryStorage());
    expect(a.address).not.toBe(b.address);
  });

  it('signs the exact intent bytes with a signature that verifies (Ed25519)', async () => {
    const wallet = await demoWallet(memoryStorage());
    const bytes = new TextEncoder().encode(INTENT);
    const signature = await wallet.signIntent(bytes, signal());
    const key = await getPublicKeyFromAddress(wallet.address);
    expect(signature).toHaveLength(64);
    expect(await verifySignature(key, signature, bytes)).toBe(true);
    expect(await verifySignature(key, signature, new TextEncoder().encode(`${INTENT}\n`))).toBe(
      false,
    );
  });

  it('a restored wallet signs with the same key', async () => {
    const storage = memoryStorage();
    const first = await demoWallet(storage);
    const restored = await demoWallet(storage);
    const bytes = new TextEncoder().encode(INTENT);
    const key = await getPublicKeyFromAddress(first.address);
    expect(await verifySignature(key, await restored.signIntent(bytes, signal()), bytes)).toBe(
      true,
    );
  });

  it('falls back to an ephemeral wallet that still works when storage throws', async () => {
    const wallet = await demoWallet(brokenStorage);
    const bytes = new TextEncoder().encode(INTENT);
    const key = await getPublicKeyFromAddress(wallet.address);
    expect(await verifySignature(key, await wallet.signIntent(bytes, signal()), bytes)).toBe(true);
  });

  it('replaces a corrupt stored seed with a fresh wallet instead of throwing', async () => {
    const corrupt: StoragePort = {
      get: () => 'not a seed!',
      set: () => undefined,
      remove: () => undefined,
    };
    const wallet = await demoWallet(corrupt);
    expect(wallet.address.length).toBeGreaterThanOrEqual(32);
  });
});
