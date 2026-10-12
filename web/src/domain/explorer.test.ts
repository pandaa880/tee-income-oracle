import { describe, expect, it } from 'vitest';
import { explorerAddressUrl, explorerTxUrl } from './explorer.ts';
import { SIG } from '../test-support/fakes.ts';
import { ADMIN } from '../test-support/fixtures.ts';

describe('explorer URLs', () => {
  it('links an address on the cluster', () => {
    expect(explorerAddressUrl('devnet', ADMIN)).toBe(
      `https://explorer.solana.com/address/${ADMIN}?cluster=devnet`,
    );
  });

  it('links a transaction on the cluster', () => {
    expect(explorerTxUrl('devnet', SIG)).toBe(
      `https://explorer.solana.com/tx/${SIG}?cluster=devnet`,
    );
  });
});
