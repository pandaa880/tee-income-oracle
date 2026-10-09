// Browser storage behind a port. Private windows and blocked site data throw: we swallow it.
import type { StoragePort } from '../domain/ports.ts';

export function createStorage(backend: Storage = sessionStorage): StoragePort {
  return {
    get(key) {
      try {
        return backend.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        backend.setItem(key, value);
      } catch {
        // Not persisted; the value lives only as long as the page.
      }
    },
    remove(key) {
      try {
        backend.removeItem(key);
      } catch {
        // Nothing to undo.
      }
    },
  };
}
