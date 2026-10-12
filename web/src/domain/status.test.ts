import { describe, expect, it } from 'vitest';
import { registeredBuild, serviceStatus, statusLabel } from './status.ts';
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
      measurementId: INFO.measurementId,
    });
  });

  it('is down when /v1/info cannot be read', () => {
    expect(serviceStatus(fail({ code: 'network' }), live.entry, live.health)).toEqual({
      state: 'down',
      reason: 'gateway_unreachable',
      measurementId: null,
    });
  });

  it('is down when the registry entry does not exist', () => {
    expect(serviceStatus(live.info, ok(null), live.health)).toEqual({
      state: 'down',
      reason: 'enclave_not_registered',
      measurementId: INFO.measurementId,
    });
  });

  it('is down when the registry entry is revoked', () => {
    expect(serviceStatus(live.info, ok(entry({ revokedAt: 5n })), live.health)).toEqual({
      state: 'down',
      reason: 'enclave_revoked',
      measurementId: INFO.measurementId,
    });
  });

  it('is down when the entry attester differs from the one the gateway reports', () => {
    const other = { ...INFO, attesterAddress: `0x${'aa'.repeat(20)}` };
    expect(serviceStatus(ok(other), live.entry, live.health)).toEqual({
      state: 'down',
      reason: 'attester_mismatch',
      measurementId: INFO.measurementId,
    });
  });

  it('is degraded, not down, when the registry cannot be read (the RPC is the problem)', () => {
    expect(serviceStatus(live.info, fail({ code: 'rpc_busy' }), live.health)).toEqual({
      state: 'degraded',
      reason: 'registry_unreadable',
      measurementId: INFO.measurementId,
    });
  });

  it('is degraded when /health fails but /v1/info answered', () => {
    expect(serviceStatus(live.info, live.entry, fail({ code: 'timeout' }))).toEqual({
      state: 'degraded',
      reason: 'health_check_failed',
      measurementId: INFO.measurementId,
    });
  });

  it('compares the attester case-insensitively', () => {
    const upper = { ...INFO, attesterAddress: `0x${'C3'.repeat(20)}` };
    expect(serviceStatus(ok(upper), live.entry, live.health).state).toBe('live');
  });
});

describe('statusLabel', () => {
  it('shows the live strip with the enclave build number and no banner', () => {
    const label = statusLabel({ state: 'live', reason: null, measurementId: 3 });
    expect(label.strip).toContain('LIVE ON DEVNET');
    expect(label.strip).toContain('ENCLAVE BUILD #3');
    expect(label.banner).toBeNull();
  });

  it.each([
    ['degraded', 'health_check_failed'],
    ['degraded', 'registry_unreadable'],
    ['down', 'gateway_unreachable'],
    ['down', 'enclave_not_registered'],
    ['down', 'enclave_revoked'],
    ['down', 'attester_mismatch'],
  ] as const)('explains %s (%s) in words in a banner', (state, reason) => {
    const label = statusLabel({ state, reason, measurementId: null });
    expect(label.banner).not.toBeNull();
    expect(label.banner).not.toContain('_');
    expect(label.banner?.length).toBeGreaterThan(10);
  });

  it('marks a down service in the strip', () => {
    const label = statusLabel({ state: 'down', reason: 'enclave_revoked', measurementId: 0 });
    expect(label.strip).toContain('DOWN');
  });
});

describe('registeredBuild (only a registry-confirmed build gets a number)', () => {
  it.each([
    ['live', null, 3],
    ['degraded', 'health_check_failed', 3],
    ['degraded', 'registry_unreadable', null],
    ['down', 'enclave_revoked', null],
    ['down', 'enclave_not_registered', null],
    ['down', 'attester_mismatch', null],
    ['down', 'gateway_unreachable', null],
  ] as const)('%s / %s -> %s', (state, reason, expected) => {
    expect(registeredBuild({ state, reason, measurementId: 3 })).toBe(expected);
  });

  it('is null before the status is read', () => {
    expect(registeredBuild(undefined)).toBeNull();
  });
});

describe('statusLabel extras', () => {
  it('names the pools reading the oracle when live', () => {
    const up = { state: 'live', reason: null, measurementId: 1 } as const;
    expect(statusLabel(up, 2).strip).toContain('2 POOLS READING THE ORACLE');
  });

  it('never numbers a build the registry did not confirm', () => {
    const revoked = { state: 'down', reason: 'enclave_revoked', measurementId: 1 } as const;
    expect(statusLabel(revoked).strip).not.toContain('#1');
  });

  it('colours a down banner negative and a degraded one caution', () => {
    expect(
      statusLabel({ state: 'down', reason: 'enclave_revoked', measurementId: 0 }).bannerTone,
    ).toBe('negative');
    expect(
      statusLabel({ state: 'degraded', reason: 'health_check_failed', measurementId: 0 })
        .bannerTone,
    ).toBe('caution');
  });
});
