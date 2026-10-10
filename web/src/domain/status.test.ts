import { describe, expect, it } from 'vitest';
import { serviceStatus } from './status.ts';
import { entry } from '../test-support/fixtures.ts';
import { fail, INFO, ok } from '../test-support/fakes.ts';

const live = {
  info: ok(INFO),
  entry: ok(entry()),
  health: ok(true as const),
};

describe('serviceStatus', () => {
  it('is live when the gateway answers, the entry is active and its attester matches /v1/info', () => {
    expect(serviceStatus(live.info, live.entry, live.health)).toEqual({
      state: 'live',
      reason: null,
    });
  });

  it('is down when /v1/info cannot be read', () => {
    expect(serviceStatus(fail({ code: 'network' }), live.entry, live.health)).toEqual({
      state: 'down',
      reason: 'gateway_unreachable',
    });
  });

  it('is down when the registry entry does not exist', () => {
    expect(serviceStatus(live.info, ok(null), live.health)).toEqual({
      state: 'down',
      reason: 'enclave_not_registered',
    });
  });

  it('is down when the registry entry is revoked', () => {
    expect(serviceStatus(live.info, ok(entry({ revokedAt: 5n })), live.health)).toEqual({
      state: 'down',
      reason: 'enclave_revoked',
    });
  });

  it('is down when the entry attester differs from the one the gateway reports', () => {
    const other = { ...INFO, attesterAddress: `0x${'aa'.repeat(20)}` };
    expect(serviceStatus(ok(other), live.entry, live.health)).toEqual({
      state: 'down',
      reason: 'attester_mismatch',
    });
  });

  it('is degraded, not down, when the registry cannot be read (the RPC is the problem)', () => {
    expect(serviceStatus(live.info, fail({ code: 'rpc_busy' }), live.health)).toEqual({
      state: 'degraded',
      reason: 'registry_unreadable',
    });
  });

  it('is degraded when /health fails but /v1/info answered', () => {
    expect(serviceStatus(live.info, live.entry, fail({ code: 'timeout' }))).toEqual({
      state: 'degraded',
      reason: 'health_check_failed',
    });
  });

  it('compares the attester case-insensitively', () => {
    const upper = { ...INFO, attesterAddress: `0x${'C3'.repeat(20)}` };
    expect(serviceStatus(ok(upper), live.entry, live.health).state).toBe('live');
  });
});
