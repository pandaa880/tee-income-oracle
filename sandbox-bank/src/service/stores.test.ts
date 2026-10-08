import { describe, expect, it } from 'vitest';

import { testKeys } from '../testing/fixtures.ts';
import { pinned } from '../vectors/keys.ts';
import {
  createConsentStore,
  createFiuKeyStore,
  createSessionStore,
  type ConsentRecord,
  type FiSession,
  type FiuKey,
} from './stores.ts';

const T0 = 1_790_416_800;

function consent(id: string, expiresAt = T0 + 86_400): ConsentRecord {
  return {
    consentId: id,
    personaId: 'salaried_steady',
    jws: `h.p.sig-${id}`,
    signature: `sig-${id}`,
    from: T0 - 366 * 86_400,
    to: T0 + 86_400,
    expiresAt,
    used: false,
  };
}

function session(id: string, expiresAt = T0 + 600): FiSession {
  return {
    sessionId: id,
    txnid: `txn-${id}`,
    consentId: 'c',
    fetchBody: new Uint8Array([1, 2, 3]),
    fetchJws: 'a..b',
    expiresAt,
    fetched: false,
  };
}

function fiuKey(kid: string): FiuKey {
  return { kid, key: pinned(testKeys().fiu), attester: new Uint8Array(20) };
}

describe('ConsentStore', () => {
  it('returns what was added', () => {
    const store = createConsentStore({ now: () => T0, cap: 4 });
    expect(store.add(consent('a'))).toBe(true);
    expect(store.get('a')?.signature).toBe('sig-a');
  });

  it('returns undefined for an unknown id', () => {
    expect(createConsentStore({ now: () => T0 }).get('nope')).toBeUndefined();
  });

  it('starts unused and markUsed flips the flag', () => {
    const store = createConsentStore({ now: () => T0 });
    store.add(consent('a'));
    expect(store.get('a')?.used).toBe(false);
    store.markUsed('a');
    expect(store.get('a')?.used).toBe(true);
  });

  it('markUsed on one consent leaves the others unused', () => {
    const store = createConsentStore({ now: () => T0 });
    store.add(consent('a'));
    store.add(consent('b'));
    store.markUsed('a');
    expect(store.get('b')?.used).toBe(false);
  });

  it('when full, evicts the oldest unused consent instead of refusing (no lockout)', () => {
    const store = createConsentStore({ now: () => T0, cap: 2 });
    expect(store.add(consent('a'))).toBe(true);
    expect(store.add(consent('b'))).toBe(true);
    expect(store.add(consent('c'))).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
    expect(store.get('c')).toBeDefined();
  });

  it('when full of used consents, add succeeds and evicts the oldest used one', () => {
    const store = createConsentStore({ now: () => T0, cap: 2 });
    store.add(consent('a'));
    store.add(consent('b'));
    store.markUsed('a');
    store.markUsed('b');
    expect(store.add(consent('c'))).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')?.used).toBe(true);
    expect(store.get('c')).toBeDefined();
  });

  it('evicts a used consent before an unused one when the used one is older', () => {
    const store = createConsentStore({ now: () => T0, cap: 2 });
    store.add(consent('a'));
    store.add(consent('b'));
    store.markUsed('a');
    expect(store.add(consent('c'))).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')?.used).toBe(false);
    expect(store.get('c')).toBeDefined();
  });

  it('evicts a used consent before an unused one even when the used one is newer', () => {
    const store = createConsentStore({ now: () => T0, cap: 2 });
    store.add(consent('a'));
    store.add(consent('b'));
    store.markUsed('b');
    expect(store.add(consent('c'))).toBe(true);
    expect(store.get('a')?.used).toBe(false);
    expect(store.get('b')).toBeUndefined();
    expect(store.get('c')).toBeDefined();
  });

  it('sweeps expired consents before the cap check', () => {
    const clock = { t: T0 };
    const store = createConsentStore({ now: () => clock.t, cap: 2 });
    store.add(consent('a', T0 + 100));
    store.add(consent('b', T0 + 100));
    clock.t = T0 + 101;
    expect(store.add(consent('c', T0 + 86_400))).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeUndefined();
    expect(store.get('c')).toBeDefined();
  });

  it('a valid used consent is not swept, but is evicted by the cap when full', () => {
    const clock = { t: T0 };
    const store = createConsentStore({ now: () => clock.t, cap: 1 });
    store.add(consent('a', T0 + 100));
    store.markUsed('a');
    clock.t = T0 + 99;
    expect(store.add(consent('b'))).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
  });

  it('defaults to a cap of 1024', () => {
    const store = createConsentStore({ now: () => T0 });
    for (let i = 0; i < 1024; i += 1) {
      expect(store.add(consent(`c${i}`))).toBe(true);
    }
    expect(store.add(consent('one-too-many'))).toBe(true);
    expect(store.get('c0')).toBeUndefined();
    expect(store.get('c1')).toBeDefined();
  });
});

describe('SessionStore', () => {
  it('returns what was added', () => {
    const store = createSessionStore({ now: () => T0 });
    expect(store.add(session('s1'))).toBe(true);
    expect(store.get('s1')?.txnid).toBe('txn-s1');
  });

  it('returns undefined for an unknown id', () => {
    expect(createSessionStore({ now: () => T0 }).get('nope')).toBeUndefined();
  });

  it('returns undefined once the session has expired', () => {
    const clock = { t: T0 };
    const store = createSessionStore({ now: () => clock.t });
    store.add(session('s1', T0 + 600));
    clock.t = T0 + 601;
    expect(store.get('s1')).toBeUndefined();
  });

  it('still returns the session just before it expires', () => {
    const clock = { t: T0 };
    const store = createSessionStore({ now: () => clock.t });
    store.add(session('s1', T0 + 600));
    clock.t = T0 + 599;
    expect(store.get('s1')).toBeDefined();
  });

  it('starts unfetched and markFetched flips the flag', () => {
    const store = createSessionStore({ now: () => T0 });
    store.add(session('s1'));
    expect(store.get('s1')?.fetched).toBe(false);
    store.markFetched('s1');
    expect(store.get('s1')?.fetched).toBe(true);
  });

  it('refuses an add past the cap with false', () => {
    const store = createSessionStore({ now: () => T0, cap: 2 });
    store.add(session('a'));
    store.add(session('b'));
    expect(store.add(session('c'))).toBe(false);
  });

  it('when full of fetched sessions, add evicts the oldest fetched one', () => {
    const store = createSessionStore({ now: () => T0, cap: 2 });
    store.add(session('a'));
    store.add(session('b'));
    store.markFetched('a');
    store.markFetched('b');
    expect(store.add(session('c'))).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')?.fetched).toBe(true);
    expect(store.get('c')).toBeDefined();
  });

  it('evicts a fetched session before an unfetched one, even a newer fetched one', () => {
    const store = createSessionStore({ now: () => T0, cap: 2 });
    store.add(session('a'));
    store.add(session('b'));
    store.markFetched('b');
    expect(store.add(session('c'))).toBe(true);
    expect(store.get('a')?.fetched).toBe(false);
    expect(store.get('b')).toBeUndefined();
  });

  it('sweeps expired sessions before the cap check', () => {
    const clock = { t: T0 };
    const store = createSessionStore({ now: () => clock.t, cap: 1 });
    store.add(session('a', T0 + 600));
    clock.t = T0 + 700;
    expect(store.add(session('b', T0 + 1300))).toBe(true);
  });

  it('defaults to a cap of 256', () => {
    const store = createSessionStore({ now: () => T0 });
    for (let i = 0; i < 256; i += 1) {
      expect(store.add(session(`s${i}`))).toBe(true);
    }
    expect(store.add(session('one-too-many'))).toBe(false);
  });
});

describe('FiuKeyStore', () => {
  it('returns a key by kid', () => {
    const store = createFiuKeyStore({});
    store.put(fiuKey('k1'));
    expect(store.get('k1')?.kid).toBe('k1');
  });

  it('returns undefined for an unknown kid', () => {
    expect(createFiuKeyStore({}).get('nope')).toBeUndefined();
  });

  it('evicts the oldest key when the cap is exceeded', () => {
    const store = createFiuKeyStore({ cap: 2 });
    store.put(fiuKey('k1'));
    store.put(fiuKey('k2'));
    store.put(fiuKey('k3'));
    expect(store.get('k1')).toBeUndefined();
    expect(store.get('k2')).toBeDefined();
    expect(store.get('k3')).toBeDefined();
  });

  it('putting the same kid again does not evict another key', () => {
    const store = createFiuKeyStore({ cap: 2 });
    store.put(fiuKey('k1'));
    store.put(fiuKey('k2'));
    store.put(fiuKey('k2'));
    expect(store.get('k1')).toBeDefined();
    expect(store.get('k2')).toBeDefined();
  });

  it('defaults to a cap of 16', () => {
    const store = createFiuKeyStore({});
    for (let i = 0; i < 17; i += 1) {
      store.put(fiuKey(`k${i}`));
    }
    expect(store.get('k0')).toBeUndefined();
    expect(store.get('k1')).toBeDefined();
    expect(store.get('k16')).toBeDefined();
  });
});
