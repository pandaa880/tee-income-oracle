/**
 * Read-only view of the oracle's enclave registry (FORMATS §13): is an
 * attester address registered and not revoked? The bank asks this before it
 * trusts an FIU key (§8.1).
 *
 * Reads `Config` for `next_measurement_id`, then every `EnclaveEntry` PDA
 * below it (at most 255, in batches of 100). No `getProgramAccounts`: some
 * RPC providers throttle or bill it extra. The Codama client isn't used
 * because it needs bundler resolution; the layouts are FROZEN, so a small
 * hand-written decoder is enough.
 */

import { createHash } from 'node:crypto';

import {
  address,
  createSolanaRpc,
  getProgramDerivedAddress,
  type Address,
  type Base64EncodedBytes,
} from '@solana/kit';

import { b64Decode, toHex } from '../crypto/encoding.ts';

export type RegistryResult =
  | { readonly ok: true; readonly active: boolean }
  /** The chain couldn't be read or an account didn't decode: never treated as active. */
  | { readonly ok: false };

export interface AttesterRegistry {
  isActive(attester: Uint8Array): Promise<RegistryResult>;
}

/** The two RPC reads the registry needs; account data or `null` if the account doesn't exist. */
export interface RegistryRpc {
  getAccountData(address: string): Promise<Uint8Array | null>;
  getMultipleAccountData(addresses: readonly string[]): Promise<(Uint8Array | null)[]>;
}

const DISC_LEN = 8;
const PUBKEY_LEN = 32;
const ENTRY_LEN = 112;
const ATTESTER_OFFSET = 44;
const ATTESTER_LEN = 20;
const REVOKED_AT_OFFSET = 104;
const DEFAULT_TTL_SECS = 30;
const DEFAULT_SNAPSHOT_SECS = 5;
const DEFAULT_TIMEOUT_MS = 5_000;
/** Account `version` the decoder understands (FORMATS §0.1, §13). */
const ACCOUNT_VERSION = 1;
const MAX_ACCOUNTS_PER_CALL = 100;

export const CONFIG_DISCRIMINATOR = anchorDiscriminator('Config');
export const ENCLAVE_ENTRY_DISCRIMINATOR = anchorDiscriminator('EnclaveEntry');

/** `Config`: disc ‖ version u8 ‖ bump u8 ‖ admin ‖ pending_admin Option<Pubkey> ‖ next u8. */
export function decodeConfig(data: Uint8Array): { readonly nextMeasurementId: number } {
  expectDiscriminator(data, CONFIG_DISCRIMINATOR);
  expectVersion(data, 'Config');
  const tagAt = DISC_LEN + 2 + PUBKEY_LEN;
  const tag = data[tagAt];
  if (tag !== 0 && tag !== 1) {
    throw new Error('Config: bad pending_admin option tag');
  }
  const next = data[tagAt + 1 + tag * PUBKEY_LEN];
  if (next === undefined) {
    throw new Error('Config: truncated');
  }
  return { nextMeasurementId: next };
}

/** `EnclaveEntry`, exactly 112 bytes. */
export function decodeEnclaveEntry(data: Uint8Array): {
  readonly measurementId: number;
  readonly attester: Uint8Array;
  readonly revokedAt: bigint;
} {
  if (data.length !== ENTRY_LEN) {
    throw new Error(`EnclaveEntry: ${data.length} bytes, expected ${ENTRY_LEN}`);
  }
  expectDiscriminator(data, ENCLAVE_ENTRY_DISCRIMINATOR);
  expectVersion(data, 'EnclaveEntry');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    measurementId: view.getUint8(DISC_LEN + 2),
    attester: data.slice(ATTESTER_OFFSET, ATTESTER_OFFSET + ATTESTER_LEN),
    revokedAt: view.getBigInt64(REVOKED_AT_OFFSET, true),
  };
}

/**
 * Registry over RPC. Answers come from a snapshot of all entries, read at
 * most once per `snapshotSecs` (default 5 s; concurrent misses share one
 * read), so callers who send signatures of unregistered keys can't turn
 * each request into a round of RPC reads. A positive answer is also cached
 * per attester for `ttlSecs` (default 30 s), so a revoke is seen within
 * `ttlSecs + snapshotSecs` (35 s by default). A failed
 * or timed-out read (`timeoutMs`, default 5 s) is never cached and is
 * `{ ok: false }`, so an outage never becomes "active".
 */
export function createRpcRegistry(a: RegistryOptions): AttesterRegistry {
  const ttl = a.ttlSecs ?? DEFAULT_TTL_SECS;
  const entries = snapshotReader(a);
  const activeSince = new Map<string, number>();
  return {
    async isActive(attester) {
      const key = toHex(attester);
      const cachedAt = activeSince.get(key);
      if (cachedAt !== undefined && a.now() - cachedAt < ttl) {
        return { ok: true, active: true };
      }
      activeSince.delete(key);
      try {
        const active = (await entries()).some(
          (e) => e.revokedAt === 0n && toHex(e.attester) === key,
        );
        if (active) {
          activeSince.set(key, a.now());
        }
        return { ok: true, active };
      } catch {
        return { ok: false };
      }
    },
  };
}

export interface RegistryOptions {
  readonly rpc: RegistryRpc;
  readonly programId: string;
  /** Unix seconds. */
  readonly now: () => number;
  readonly ttlSecs?: number;
  readonly snapshotSecs?: number;
  readonly timeoutMs?: number;
}

type Entry = ReturnType<typeof decodeEnclaveEntry>;

/** All registry entries, from a short-lived snapshot; one read in flight at a time. */
function snapshotReader(a: RegistryOptions): () => Promise<readonly Entry[]> {
  const maxAge = a.snapshotSecs ?? DEFAULT_SNAPSHOT_SECS;
  const pdas = pdaCache(address(a.programId));
  let snapshot: { readonly at: number; readonly entries: readonly Entry[] } | undefined;
  let inFlight: Promise<readonly Entry[]> | undefined;
  return async () => {
    if (snapshot !== undefined && a.now() - snapshot.at < maxAge) {
      return snapshot.entries;
    }
    // Stamped when the read starts, so the snapshot never looks fresher than it is.
    const startedAt = a.now();
    inFlight ??= withTimeout(readEntries(a.rpc, pdas), a.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      .then((entries) => {
        snapshot = { at: startedAt, entries };
        return entries;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return await inFlight;
  };
}

/** `RegistryRpc` over a Solana JSON-RPC endpoint; each call gives up after `timeoutMs`. */
export function createSolanaRegistryRpc(
  rpcUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): RegistryRpc {
  const rpc = createSolanaRpc(rpcUrl);
  const signal = (): { abortSignal: AbortSignal } => ({
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  return {
    async getAccountData(addr) {
      const { value } = await rpc
        .getAccountInfo(address(addr), { encoding: 'base64' })
        .send(signal());
      return value === null ? null : base64Data(value.data);
    },
    async getMultipleAccountData(addrs) {
      const { value } = await rpc
        .getMultipleAccounts(
          addrs.map((x) => address(x)),
          { encoding: 'base64' },
        )
        .send(signal());
      return value.map((acc) => (acc === null ? null : base64Data(acc.data)));
    },
  };
}

interface PdaCache {
  config(): Promise<string>;
  entry(id: number): Promise<string>;
}

/** PDAs never change for a program: derive each once. */
function pdaCache(programId: Address): PdaCache {
  const known = new Map<string, Promise<string>>();
  const get = (key: string, seeds: Uint8Array[]): Promise<string> => {
    let found = known.get(key);
    if (found === undefined) {
      found = pda(programId, seeds);
      known.set(key, found);
    }
    return found;
  };
  return {
    config: () => get('config', [utf8Seed('config')]),
    entry: (id) => get(`enclave/${id}`, [utf8Seed('enclave'), Uint8Array.of(id)]),
  };
}

async function readEntries(rpc: RegistryRpc, pdas: PdaCache): Promise<Entry[]> {
  const config = await rpc.getAccountData(await pdas.config());
  if (config === null) {
    return [];
  }
  const { nextMeasurementId } = decodeConfig(config);
  const ids = Array.from({ length: nextMeasurementId }, (_, id) => id);
  const addresses = await Promise.all(ids.map((id) => pdas.entry(id)));
  const entries: Entry[] = [];
  for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_CALL) {
    const batch = await rpc.getMultipleAccountData(addresses.slice(i, i + MAX_ACCOUNTS_PER_CALL));
    for (const [j, data] of batch.entries()) {
      if (data !== null) {
        entries.push(entryAt(data, i + j));
      }
    }
  }
  return entries;
}

/** Decodes the entry at PDA seed `id`; its own `measurement_id` must match the seed. */
function entryAt(data: Uint8Array, id: number): Entry {
  const entry = decodeEnclaveEntry(data);
  if (entry.measurementId !== id) {
    throw new Error('EnclaveEntry: measurement_id differs from its PDA seed');
  }
  return entry;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`registry read timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function pda(programId: Address, seeds: Uint8Array[]): Promise<string> {
  const [found] = await getProgramDerivedAddress({ programAddress: programId, seeds });
  return found;
}

function utf8Seed(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function base64Data(data: readonly [Base64EncodedBytes, 'base64']): Uint8Array {
  return b64Decode(data[0]);
}

/** Anchor account discriminator: sha256("account:<Name>")[0..8]. */
function anchorDiscriminator(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`account:${name}`).digest()).slice(0, DISC_LEN);
}

function expectDiscriminator(data: Uint8Array, expected: Uint8Array): void {
  if (data.length < DISC_LEN || toHex(data.subarray(0, DISC_LEN)) !== toHex(expected)) {
    throw new Error('wrong account discriminator');
  }
}

/** A layout change bumps `version`: fail closed instead of misreading it. */
function expectVersion(data: Uint8Array, name: string): void {
  if (data[DISC_LEN] !== ACCOUNT_VERSION) {
    throw new Error(`${name}: unsupported account version`);
  }
}
