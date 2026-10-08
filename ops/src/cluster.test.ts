import { describe, expect, it } from 'vitest';
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  TESTNET_GENESIS_HASH,
  checkCluster,
  parseCluster,
} from './cluster.ts';

const LOCAL_HASH = '11111111111111111111111111111111111111111111';

function expectMismatch(result: ReturnType<typeof checkCluster>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('cluster_mismatch');
}

describe('genesis hash constants', () => {
  it('pins the devnet and mainnet genesis hashes', () => {
    expect(DEVNET_GENESIS_HASH).toBe('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
    expect(MAINNET_GENESIS_HASH).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  });
});

describe('checkCluster', () => {
  it('rejects localnet on testnet', () => {
    expect(TESTNET_GENESIS_HASH).toBe('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY');
    expectMismatch(checkCluster('localnet', TESTNET_GENESIS_HASH));
  });

  it('accepts devnet with the devnet hash', () => {
    expect(checkCluster('devnet', DEVNET_GENESIS_HASH)).toEqual({ ok: true });
  });

  it('accepts localnet with a local hash (baseline)', () => {
    expect(checkCluster('localnet', LOCAL_HASH)).toEqual({ ok: true });
  });

  it('rejects devnet with the mainnet hash', () => {
    expectMismatch(checkCluster('devnet', MAINNET_GENESIS_HASH));
  });

  it('rejects devnet with a local hash', () => {
    expectMismatch(checkCluster('devnet', LOCAL_HASH));
  });

  it('rejects localnet against the devnet hash', () => {
    expectMismatch(checkCluster('localnet', DEVNET_GENESIS_HASH));
  });

  it('rejects localnet against the mainnet hash', () => {
    expectMismatch(checkCluster('localnet', MAINNET_GENESIS_HASH));
  });
});

describe('parseCluster', () => {
  it('parses localnet and devnet', () => {
    expect(parseCluster('localnet')).toBe('localnet');
    expect(parseCluster('devnet')).toBe('devnet');
  });

  it('rejects an unknown value naming the allowed values', () => {
    expect(() => parseCluster('mainnet')).toThrow(/localnet/);
    expect(() => parseCluster('mainnet')).toThrow(/devnet/);
  });

  it('rejects a missing value naming the allowed values', () => {
    expect(() => parseCluster(undefined)).toThrow(/localnet/);
    expect(() => parseCluster(undefined)).toThrow(/devnet/);
  });
});
