import { describe, expect, it } from 'vitest';

import { createRateLimiter } from './rate-limit.ts';

function setup(opts: Omit<Parameters<typeof createRateLimiter>[0], 'now'> = {}) {
  const clock = { ms: 1_000_000 };
  const limiter = createRateLimiter({ now: () => clock.ms, ...opts });
  return { clock, limiter };
}

function drain(limiter: { allow(ip: string): boolean }, ip: string, tries: number): boolean[] {
  return Array.from({ length: tries }, () => limiter.allow(ip));
}

describe('per-IP bucket (default burst 5, 10 per minute)', () => {
  it('allows a burst of 5 and refuses the 6th', () => {
    const { limiter } = setup();
    expect(drain(limiter, '1.1.1.1', 6)).toEqual([true, true, true, true, true, false]);
  });

  it('refills one token per 6 seconds', () => {
    const { limiter, clock } = setup();
    drain(limiter, '1.1.1.1', 5);
    clock.ms += 5_000;
    expect(limiter.allow('1.1.1.1')).toBe(false);
    clock.ms += 1_000;
    expect(limiter.allow('1.1.1.1')).toBe(true);
    expect(limiter.allow('1.1.1.1')).toBe(false);
  });

  it('never refills above the burst', () => {
    const { limiter, clock } = setup();
    drain(limiter, '1.1.1.1', 5);
    clock.ms += 3_600_000;
    expect(drain(limiter, '1.1.1.1', 6)).toEqual([true, true, true, true, true, false]);
  });

  it('keeps IPs isolated', () => {
    const { limiter } = setup();
    drain(limiter, '1.1.1.1', 5);
    expect(limiter.allow('1.1.1.1')).toBe(false);
    expect(limiter.allow('2.2.2.2')).toBe(true);
  });

  it('honours a custom perIp config', () => {
    const { limiter, clock } = setup({ perIp: { burst: 1, perMinute: 60 } });
    expect(drain(limiter, 'a', 2)).toEqual([true, false]);
    clock.ms += 1_000;
    expect(limiter.allow('a')).toBe(true);
  });
});

describe('global bucket (default burst 20, 60 per minute)', () => {
  it('caps the total across IPs at 20', () => {
    const { limiter } = setup();
    const results = ['a', 'b', 'c', 'd'].flatMap((ip) => drain(limiter, ip, 5));
    expect(results.every(Boolean)).toBe(true);
    expect(limiter.allow('e')).toBe(false);
  });

  it('refills one global token per second', () => {
    const { limiter, clock } = setup();
    ['a', 'b', 'c', 'd'].forEach((ip) => drain(limiter, ip, 5));
    clock.ms += 1_000;
    expect(limiter.allow('e')).toBe(true);
    expect(limiter.allow('f')).toBe(false);
  });
});

describe('refused calls do not consume the other bucket', () => {
  it('a global refusal leaves the per-IP bucket intact', () => {
    const { limiter, clock } = setup({
      perIp: { burst: 2, perMinute: 1 },
      global: { burst: 2, perMinute: 60 },
    });
    expect(drain(limiter, 'a', 2)).toEqual([true, true]); // global now empty
    expect(drain(limiter, 'b', 3)).toEqual([false, false, false]);
    clock.ms += 2_000; // two global tokens back; b's own bucket must still hold 2
    expect(drain(limiter, 'b', 3)).toEqual([true, true, false]);
  });

  it('a per-IP refusal leaves the global bucket intact', () => {
    const { limiter } = setup({
      perIp: { burst: 1, perMinute: 1 },
      global: { burst: 2, perMinute: 1 },
    });
    expect(limiter.allow('a')).toBe(true); // one global token left
    expect(drain(limiter, 'a', 5)).toEqual([false, false, false, false, false]);
    expect(limiter.allow('b')).toBe(true); // takes the last global token
  });
});

describe('IP map bound', () => {
  it('keeps working past maxIps distinct addresses', () => {
    const { limiter } = setup({
      maxIps: 4,
      perIp: { burst: 1, perMinute: 1 },
      global: { burst: 1_000, perMinute: 60_000 },
    });
    const results = Array.from({ length: 50 }, (_, i) => limiter.allow(`10.0.0.${i}`));
    expect(results.every(Boolean)).toBe(true);
  });
});
