/**
 * In-memory state of the live bank: issued consents, prepared FI sessions
 * and registered FIU keys. Every store is capped; expired records are swept
 * before the cap is checked. All times are unix seconds. A restart forgets
 * everything, which only means the gateway starts a new session.
 */

import type { PinnedKey } from '../crypto/jws.ts';
import type { PersonaId } from '../vectors/personas.ts';

export interface ConsentRecord {
  readonly consentId: string;
  readonly personaId: PersonaId;
  /** The compact JWS as issued (FORMATS §5.3). */
  readonly jws: string;
  /** Its signature segment: the FI request's `Consent.digitalSignature` must equal it. */
  readonly signature: string;
  /** The consent's `FIDataRange`. */
  readonly from: number;
  readonly to: number;
  /** `consentExpiry`. */
  readonly expiresAt: number;
  /** `fetchType ONETIME`: one FI request per consent. */
  readonly used: boolean;
}

export interface FiSession {
  readonly sessionId: string;
  readonly txnid: string;
  readonly consentId: string;
  /** The exact signed fetch-response bytes and the AA's detached JWS over them. */
  readonly fetchBody: Uint8Array;
  readonly fetchJws: string;
  readonly expiresAt: number;
  /** One fetch per session; later ones get `DataGone`. */
  readonly fetched: boolean;
}

export interface FiuKey {
  readonly kid: string;
  readonly key: PinnedKey;
  /** 20-byte attester address its §8.1 binding recovered to. */
  readonly attester: Uint8Array;
}

export interface ConsentStore {
  /**
   * Never refuses: when full, the oldest used consent makes room, else the
   * oldest unused one. Refusing would let anyone lock new borrowers out for
   * the consent lifetime (a day) by completing sessions, each of which
   * leaves a used consent behind. A used consent only exists to refuse a
   * replay, and an evicted one is refused too (`InvalidConsentId`).
   * Deployment invariant: only the gateway reaches the bank (FORMATS §15),
   * and it rate-limits; a flood can then at worst evict an unused consent,
   * which the borrower re-requests. (`false` is reachable only with cap 0.)
   */
  add(record: ConsentRecord): boolean;
  /** Also returns an expired, not yet swept consent, so the caller can name the error. */
  get(consentId: string): ConsentRecord | undefined;
  markUsed(consentId: string): void;
}

export interface SessionStore {
  /** When full, the oldest fetched session makes room; false if none is fetched. */
  add(session: FiSession): boolean;
  /** Undefined once `now > expiresAt`. */
  get(sessionId: string): FiSession | undefined;
  markFetched(sessionId: string): void;
}

export interface FiuKeyStore {
  put(key: FiuKey): void;
  get(kid: string): FiuKey | undefined;
}

type Clock = () => number;

export function createConsentStore(a: {
  readonly now: Clock;
  readonly cap?: number;
}): ConsentStore {
  const store = cappedMap<ConsentRecord>(a.cap ?? 1024, (r) => r.expiresAt <= a.now(), [
    (r) => r.used,
    (r) => !r.used,
  ]);
  return {
    add: (r) => store.add(r.consentId, r),
    get: (id) => store.map.get(id),
    markUsed: (id) => store.update(id, (r) => ({ ...r, used: true })),
  };
}

export function createSessionStore(a: {
  readonly now: Clock;
  readonly cap?: number;
}): SessionStore {
  const expired = (s: FiSession): boolean => a.now() > s.expiresAt;
  // A fetched session only exists to answer `DataGone`; evicted, it is refused
  // as `InvalidSessionId`, so completed sessions can't fill the store.
  const store = cappedMap<FiSession>(a.cap ?? 256, expired, [(s) => s.fetched]);
  return {
    add: (s) => store.add(s.sessionId, s),
    get: (id) => {
      const s = store.map.get(id);
      return s === undefined || expired(s) ? undefined : s;
    },
    markFetched: (id) => store.update(id, (s) => ({ ...s, fetched: true })),
  };
}

/** Keeps the newest `cap` keys (one per enclave boot); the oldest is evicted first. */
export function createFiuKeyStore(a: { readonly cap?: number }): FiuKeyStore {
  const cap = a.cap ?? 16;
  const keys = new Map<string, FiuKey>();
  return {
    put(key) {
      keys.delete(key.kid);
      keys.set(key.kid, key);
      for (const oldest of keys.keys()) {
        if (keys.size <= cap) {
          break;
        }
        keys.delete(oldest);
      }
    },
    get: (kid) => keys.get(kid),
  };
}

/**
 * A map of at most `cap` records. `add` sweeps expired records first; if it
 * is still full, it drops the oldest record matching the first predicate in
 * `evictionOrder` that matches any, else refuses.
 */
function cappedMap<T>(
  cap: number,
  isExpired: (record: T) => boolean,
  evictionOrder: readonly ((record: T) => boolean)[] = [],
) {
  const map = new Map<string, T>();
  return {
    map,
    add(id: string, record: T): boolean {
      for (const [key, value] of map) {
        if (isExpired(value)) {
          map.delete(key);
        }
      }
      if (map.size >= cap) {
        const oldest = oldestMatch(map, evictionOrder);
        if (oldest === undefined) {
          return false;
        }
        map.delete(oldest);
      }
      map.set(id, record);
      return true;
    },
    update(id: string, change: (record: T) => T): void {
      const record = map.get(id);
      if (record !== undefined) {
        map.set(id, change(record));
      }
    },
  };
}

/** Key of the oldest record matching the first predicate that matches any. */
function oldestMatch<T>(
  map: ReadonlyMap<string, T>,
  order: readonly ((record: T) => boolean)[],
): string | undefined {
  for (const matches of order) {
    for (const [key, value] of map) {
      if (matches(value)) {
        return key;
      }
    }
  }
  return undefined;
}
