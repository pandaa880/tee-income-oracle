import { describe, expect, it } from 'vitest';
import { queryKeys } from './query-keys.ts';
import { ADMIN, POOL_0 } from '../test-support/fixtures.ts';

describe('queryKeys', () => {
  it('are [resource, cluster, address] so a cluster or wallet change never shares a cache entry', () => {
    expect(queryKeys.credential('devnet', ADMIN)).toEqual(['credential', 'devnet', ADMIN]);
    expect(queryKeys.loan('devnet', POOL_0, ADMIN)).toEqual(['loan', 'devnet', POOL_0, ADMIN]);
    expect(queryKeys.credential('devnet', ADMIN)).not.toEqual(
      queryKeys.credential('localnet', ADMIN),
    );
  });

  it('keys the service status by cluster', () => {
    expect(queryKeys.status('devnet')).toEqual(['status', 'devnet']);
  });
});
