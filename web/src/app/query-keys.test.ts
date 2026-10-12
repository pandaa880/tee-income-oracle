import { describe, expect, it } from 'vitest';
import { queryKeys } from './query-keys.ts';
import { ADMIN, POOL_0 } from '../test-support/fixtures.ts';

describe('queryKeys', () => {
  it('are [resource, cluster, address] so a cluster or wallet change never shares a cache entry', () => {
    expect(queryKeys.credential('devnet', ADMIN)).toEqual(['credential', 'devnet', ADMIN]);
    expect(queryKeys.pool('devnet', POOL_0, ADMIN)).toEqual(['pool', 'devnet', POOL_0, ADMIN]);
    expect(queryKeys.credential('devnet', ADMIN)).not.toEqual(
      queryKeys.credential('localnet', ADMIN),
    );
    expect(queryKeys.pool('devnet', POOL_0, ADMIN)).not.toEqual(
      queryKeys.pool('localnet', POOL_0, ADMIN),
    );
  });

  it('keys the service status by cluster', () => {
    expect(queryKeys.status('devnet')).toEqual(['status', 'devnet']);
  });

  it('no longer has a loan key (the pool read carries the loan)', () => {
    expect(queryKeys).not.toHaveProperty('loan');
  });
});
