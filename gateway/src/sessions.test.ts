import { describe, expect, it } from 'vitest';

import { expectThrown } from './testing/expect-rejected.ts';
import { createSessionStore } from './sessions.ts';

const T0 = 1_790_000_000;
const SESSION = {
  consentJws: 'a.b.c',
  wallet: '3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND',
  fiRequestBodyB64: 'e30=',
  fiRequestJws: 'x..y',
};

function setup(opts: { cap?: number; ttlSecs?: number } = {}) {
  const clock = { t: T0 };
  const store = createSessionStore({ now: () => clock.t, ...opts });
  return { clock, store };
}

describe('session store', () => {
  it('returns what was put and removes it (single use)', () => {
    const { store } = setup();
    store.put('s1', SESSION);
    expect(store.size()).toBe(1);
    expect(store.take('s1')).toEqual(SESSION);
    expect(store.size()).toBe(0);
    expectThrown(() => store.take('s1'), {
      code: 'session_not_found',
      stage: 'gateway',
      status: 404,
    });
  });

  it('rejects an unknown id with session_not_found 404', () => {
    const { store } = setup();
    expectThrown(() => store.take('nope'), {
      code: 'session_not_found',
      stage: 'gateway',
      status: 404,
    });
  });

  it('keeps sessions apart by id', () => {
    const { store } = setup();
    store.put('s1', SESSION);
    store.put('s2', { ...SESSION, wallet: 'other' });
    expect(store.take('s2').wallet).toBe('other');
    expect(store.take('s1').wallet).toBe(SESSION.wallet);
  });

  it('serves a session just inside the default 600 s TTL', () => {
    const { store, clock } = setup();
    store.put('s1', SESSION);
    clock.t = T0 + 599;
    expect(store.take('s1')).toEqual(SESSION);
  });

  it('rejects a session past the default 600 s TTL with session_expired 410', () => {
    const { store, clock } = setup();
    store.put('s1', SESSION);
    clock.t = T0 + 601;
    expectThrown(() => store.take('s1'), {
      code: 'session_expired',
      stage: 'gateway',
      status: 410,
    });
  });

  it('honours a custom ttlSecs', () => {
    const { store, clock } = setup({ ttlSecs: 10 });
    store.put('s1', SESSION);
    clock.t = T0 + 11;
    expectThrown(() => store.take('s1'), {
      code: 'session_expired',
      stage: 'gateway',
      status: 410,
    });
  });

  it('refuses a put when full with too_many_sessions 503', () => {
    const { store } = setup({ cap: 2 });
    store.put('s1', SESSION);
    store.put('s2', SESSION);
    expectThrown(() => store.put('s3', SESSION), {
      code: 'too_many_sessions',
      stage: 'gateway',
      status: 503,
    });
    expect(store.size()).toBe(2);
  });

  it('sweeps expired sessions before refusing a put', () => {
    const { store, clock } = setup({ cap: 2 });
    store.put('s1', SESSION);
    store.put('s2', SESSION);
    clock.t = T0 + 601;
    store.put('s3', SESSION);
    expect(store.size()).toBe(1);
    expect(store.take('s3')).toEqual(SESSION);
  });

  it('frees capacity when a session is taken', () => {
    const { store } = setup({ cap: 1 });
    store.put('s1', SESSION);
    store.take('s1');
    store.put('s2', SESSION);
    expect(store.size()).toBe(1);
  });

  it('holds 256 sessions by default and refuses the 257th', () => {
    const { store } = setup();
    for (let i = 0; i < 256; i += 1) store.put(`s${i}`, SESSION);
    expectThrown(() => store.put('extra', SESSION), {
      code: 'too_many_sessions',
      stage: 'gateway',
      status: 503,
    });
  });
});
