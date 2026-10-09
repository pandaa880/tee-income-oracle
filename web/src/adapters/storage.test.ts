import { afterEach, describe, expect, it } from 'vitest';
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
});
