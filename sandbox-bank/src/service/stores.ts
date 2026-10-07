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
   * When full, the oldest unused consent makes room: `/Consent` needs no
   * authentication, so refusing would let anyone lock new borrowers out.
   * Deployment invariant: the bank is reachable only from the gateway
   * (internal ingress), which rate-limits; a flood can then at worst evict
   * an unused consent, which the borrower re-requests.
   * False only when every stored consent is already used (each use is an
   * FI request signed by a registered enclave).
   */
  add(record: ConsentRecord): boolean;
  /** Also returns an expired, not yet swept consent, so the caller can name the error. */
  get(consentId: string): ConsentRecord | undefined;
  markUsed(consentId: string): void;
}

export interface SessionStore {
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
  const store = cappedMap<ConsentRecord>(
    a.cap ?? 1024,
    (r) => r.expiresAt <= a.now(),
    (r) => !r.used,
  );
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
  const store = cappedMap<FiSession>(a.cap ?? 256, expired);
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
 * is still full, it drops the oldest `evictable` record, else refuses.
 */
function cappedMap<T>(
  cap: number,
  isExpired: (record: T) => boolean,
  evictable: (record: T) => boolean = () => false,
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
        const oldest = [...map].find(([, value]) => evictable(value));
        if (oldest === undefined) {
          return false;
        }
        map.delete(oldest[0]);
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
