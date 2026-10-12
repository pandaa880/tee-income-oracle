import { isAddress } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { exampleWallets } from './example-wallets.ts';

describe('exampleWallets', () => {
  const devnet = exampleWallets('devnet');

  it('offers a few devnet borrowers, each a base58 address', () => {
    expect(devnet.length).toBeGreaterThanOrEqual(2);
    for (const example of devnet) expect(isAddress(example.wallet)).toBe(true);
  });

  it('lists every wallet once', () => {
    expect(new Set(devnet.map((e) => e.wallet)).size).toBe(devnet.length);
  });

  it('labels each example by who it is, never by a verdict the live check decides', () => {
    for (const example of devnet) {
      expect(example.label.trim().length).toBeGreaterThan(0);
      expect(example.label).not.toMatch(/\bPASS\b/);
    }
  });

  it('includes a retired build, so the FAIL side can be shown, and says so in its label', () => {
    const retired = devnet.filter((e) => e.retired);
    expect(retired.length).toBeGreaterThan(0);
    for (const example of retired) expect(example.label).toMatch(/retired/i);
    expect(devnet.some((e) => !e.retired)).toBe(true);
  });

  it('has none for a cluster without examples, including lookups that hit Object.prototype', () => {
    expect(exampleWallets('localnet')).toEqual([]);
    expect(exampleWallets('mainnet-beta')).toEqual([]);
    expect(exampleWallets('constructor')).toEqual([]);
  });
});
