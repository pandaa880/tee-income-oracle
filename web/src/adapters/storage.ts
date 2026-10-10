// Browser storage behind a port. Private windows and blocked site data throw, and so can merely
// reading `window.sessionStorage` (SecurityError when the browser blocks storage): every access,
// including obtaining the Storage object, happens inside a try.
import type { StoragePort } from '../domain/ports.ts';

export function createStorage(backend?: Storage): StoragePort {
  const store = (): Storage => backend ?? window.sessionStorage;
  return {
    get(key) {
      try {
        return store().getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        store().setItem(key, value);
      } catch {
        // Not persisted; the value lives only as long as the page.
      }
    },
    remove(key) {
      try {
        store().removeItem(key);
      } catch {
        // Nothing to undo.
      }
    },
  };
}
