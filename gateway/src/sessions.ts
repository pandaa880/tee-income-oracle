/**
 * Open sessions, in memory only (a restart drops them; the enclave's own
 * sessions would be gone too). Same cap and TTL as the enclave (FORMATS §10),
 * single use: `take` removes the entry whatever happens next.
 */
import { gatewayError } from './errors.ts';

export type SessionData = {
  consentJws: string;
  wallet: string;
  /** The enclave's exact FI request bytes (base64) and FIU JWS, carried to the bank verbatim. */
  fiRequestBodyB64: string;
  fiRequestJws: string;
};

export type SessionStore = {
  put: (id: string, data: SessionData) => void;
  take: (id: string) => SessionData;
  size: () => number;
};

type Entry = { data: SessionData; expiresAt: number };

export function createSessionStore(opts: {
  now: () => number;
  cap?: number;
  ttlSecs?: number;
}): SessionStore {
  const { now, cap = 256, ttlSecs = 600 } = opts;
  const entries = new Map<string, Entry>();

  const sweep = (): void => {
    const t = now();
    for (const [id, e] of entries) {
      if (t > e.expiresAt) entries.delete(id);
    }
  };

  return {
    put(id, data) {
      if (entries.size >= cap) sweep();
      if (entries.size >= cap) throw gatewayError('too_many_sessions', 'gateway', 503);
      entries.set(id, { data, expiresAt: now() + ttlSecs });
    },
    take(id) {
      const entry = entries.get(id);
      if (entry === undefined) throw gatewayError('session_not_found', 'gateway', 404);
      entries.delete(id);
      if (now() > entry.expiresAt) throw gatewayError('session_expired', 'gateway', 410);
      return entry.data;
    },
    size: () => entries.size,
  };
}
