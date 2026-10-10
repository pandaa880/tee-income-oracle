import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoWallet } from './wallet-demo.ts';
import { createStorage } from './storage.ts';

const throwing: Storage = {
  get length(): number {
    throw new Error('denied');
  },
  clear() {
    throw new Error('denied');
  },
  getItem() {
    throw new Error('denied');
  },
  key() {
    throw new Error('denied');
  },
  removeItem() {
    throw new Error('denied');
  },
  setItem() {
    throw new Error('quota');
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('createStorage', () => {
  it('reads, writes and removes through sessionStorage by default', () => {
    const storage = createStorage();
    expect(storage.get('k')).toBeNull();
    storage.set('k', 'v');
    expect(sessionStorage.getItem('k')).toBe('v');
    expect(storage.get('k')).toBe('v');
    storage.remove('k');
    expect(storage.get('k')).toBeNull();
  });

  it('never throws when the backend does: reads give null, writes and removes do nothing', () => {
    const storage = createStorage(throwing);
    expect(storage.get('k')).toBeNull();
    expect(() => storage.set('k', 'v')).not.toThrow();
    expect(() => storage.remove('k')).not.toThrow();
  });

  it('survives a browser where even reading window.sessionStorage throws (blocked storage)', async () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const storage = createStorage();
    expect(storage.get('k')).toBeNull();
    expect(() => storage.set('k', 'v')).not.toThrow();
    // The demo wallet still starts, as an ephemeral one.
    const wallet = await demoWallet(storage);
    expect(wallet.address.length).toBeGreaterThanOrEqual(32);
  });
});
