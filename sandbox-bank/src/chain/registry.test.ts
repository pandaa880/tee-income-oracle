import { describe, expect, it } from 'vitest';

import {
  ATTESTER_OFFSET,
  ENTRY_SIZE,
  REVOKED_AT_OFFSET,
  configAddress,
  configBytes,
  discriminator,
  entryAddress,
  entryBytes,
} from '../testing/registry-bytes.ts';
import {
  CONFIG_DISCRIMINATOR,
  ENCLAVE_ENTRY_DISCRIMINATOR,
  createRpcRegistry,
  decodeConfig,
  decodeEnclaveEntry,
  type RegistryRpc,
} from './registry.ts';

const PROGRAM_ID = 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8';
const ATTESTER_A = new Uint8Array(20).fill(0xaa);
const ATTESTER_B = new Uint8Array(20).fill(0xbb);
const ATTESTER_UNKNOWN = new Uint8Array(20).fill(0xcc);

describe('discriminators', () => {
  it('Config = sha256("account:Config")[0..8]', () => {
    expect(Buffer.from(CONFIG_DISCRIMINATOR).toString('hex')).toBe(
      Buffer.from(discriminator('Config')).toString('hex'),
    );
  });

  it('EnclaveEntry = sha256("account:EnclaveEntry")[0..8]', () => {
    expect(Buffer.from(ENCLAVE_ENTRY_DISCRIMINATOR).toString('hex')).toBe(
      Buffer.from(discriminator('EnclaveEntry')).toString('hex'),
    );
  });
});

describe('decodeConfig', () => {
  it('reads next_measurement_id when pending_admin is None', () => {
    expect(decodeConfig(configBytes({ nextMeasurementId: 3 })).nextMeasurementId).toBe(3);
  });

  it('reads next_measurement_id when pending_admin is Some (Borsh Option is variable size)', () => {
    const bytes = configBytes({ nextMeasurementId: 9, pendingAdmin: new Uint8Array(32).fill(5) });
    expect(decodeConfig(bytes).nextMeasurementId).toBe(9);
  });

  it('rejects another account type (wrong discriminator)', () => {
    const bytes = configBytes({ nextMeasurementId: 1 }).slice();
    bytes.set(discriminator('EnclaveEntry'), 0);
    expect(() => decodeConfig(bytes)).toThrow();
  });

  it('rejects truncated data', () => {
    expect(() => decodeConfig(configBytes({ nextMeasurementId: 1 }).subarray(0, 20))).toThrow();
  });
});

describe('decodeEnclaveEntry', () => {
  it('has the §13 layout: 112 bytes, attester at 44, revoked_at at 104', () => {
    expect(ENTRY_SIZE).toBe(112);
    expect(ATTESTER_OFFSET).toBe(44);
    expect(REVOKED_AT_OFFSET).toBe(104);
  });

  it('reads the attester and an active entry (revoked_at = 0)', () => {
    const entry = decodeEnclaveEntry(entryBytes({ measurementId: 2, attester: ATTESTER_A }));
    expect(Buffer.from(entry.attester).toString('hex')).toBe(
      Buffer.from(ATTESTER_A).toString('hex'),
    );
    expect(entry.revokedAt).toBe(0n);
  });

  it('reads revoked_at as a little-endian i64', () => {
    const bytes = entryBytes({ measurementId: 0, attester: ATTESTER_A, revokedAt: 1_790_123_456n });
    expect(decodeEnclaveEntry(bytes).revokedAt).toBe(1_790_123_456n);
  });

  it('rejects the wrong discriminator', () => {
    const bytes = entryBytes({ measurementId: 0, attester: ATTESTER_A }).slice();
    bytes.set(discriminator('Config'), 0);
    expect(() => decodeEnclaveEntry(bytes)).toThrow();
  });

  it('rejects data that is not 112 bytes', () => {
    const bytes = entryBytes({ measurementId: 0, attester: ATTESTER_A });
    expect(() => decodeEnclaveEntry(bytes.subarray(0, 111))).toThrow();
    expect(() => decodeEnclaveEntry(Uint8Array.from([...bytes, 0]))).toThrow();
  });
});

/** In-memory RPC keyed by PDA address, counting calls and able to fail. */
class FakeRpc implements RegistryRpc {
  readonly accounts = new Map<string, Uint8Array>();
  calls = 0;
  failing = false;

  getAccountData(address: string): Promise<Uint8Array | null> {
    this.calls += 1;
    if (this.failing) {
      return Promise.reject(new Error('rpc down'));
    }
    return Promise.resolve(this.accounts.get(address) ?? null);
  }

  getMultipleAccountData(addresses: readonly string[]): Promise<(Uint8Array | null)[]> {
    this.calls += 1;
    if (this.failing) {
      return Promise.reject(new Error('rpc down'));
    }
    return Promise.resolve(addresses.map((a) => this.accounts.get(a) ?? null));
  }
}

interface Entry {
  readonly attester: Uint8Array;
  readonly revokedAt?: bigint;
}

async function chain(entries: readonly Entry[]): Promise<FakeRpc> {
  const rpc = new FakeRpc();
  rpc.accounts.set(
    await configAddress(PROGRAM_ID),
    configBytes({ nextMeasurementId: entries.length }),
  );
  for (const [id, entry] of entries.entries()) {
    rpc.accounts.set(
      await entryAddress(PROGRAM_ID, id),
      entryBytes({ measurementId: id, ...entry }),
    );
  }
  return rpc;
}

function registryOver(rpc: RegistryRpc, clock: { t: number }) {
  return createRpcRegistry({ rpc, programId: PROGRAM_ID, now: () => clock.t });
}

describe('createRpcRegistry.isActive', () => {
  it('is active for the attester of an active entry', async () => {
    const registry = registryOver(await chain([{ attester: ATTESTER_A }]), { t: 1000 });
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: true });
  });

  it('is not active for an attester that was never registered', async () => {
    const registry = registryOver(await chain([{ attester: ATTESTER_A }]), { t: 1000 });
    expect(await registry.isActive(ATTESTER_UNKNOWN)).toEqual({ ok: true, active: false });
  });

  it('is not active when the only entry for the attester is revoked', async () => {
    const registry = registryOver(
      await chain([{ attester: ATTESTER_A, revokedAt: 1_790_000_100n }]),
      { t: 1000 },
    );
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: false });
  });

  it('finds the attester at any measurement id', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }, { attester: ATTESTER_B }]);
    const registry = registryOver(rpc, { t: 1000 });
    expect(await registry.isActive(ATTESTER_B)).toEqual({ ok: true, active: true });
  });

  it('is active if any one of several entries for the attester is active', async () => {
    const rpc = await chain([
      { attester: ATTESTER_A, revokedAt: 5n },
      { attester: ATTESTER_B },
      { attester: ATTESTER_A },
    ]);
    const registry = registryOver(rpc, { t: 1000 });
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: true });
  });

  it('is not active when the registry is not initialized (no Config account)', async () => {
    const registry = registryOver(new FakeRpc(), { t: 1000 });
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: false });
  });

  it('reports ok:false (never "active") when the RPC throws', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }]);
    rpc.failing = true;
    const registry = registryOver(rpc, { t: 1000 });
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: false });
  });

  it('reports ok:false for an account that does not decode', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }]);
    rpc.accounts.set(await entryAddress(PROGRAM_ID, 0), new Uint8Array(112));
    const registry = registryOver(rpc, { t: 1000 });
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: false });
  });
});

describe('createRpcRegistry caching', () => {
  it('serves a positive answer from cache for 30 seconds without touching the RPC', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }]);
    const clock = { t: 1000 };
    const registry = registryOver(rpc, clock);
    await registry.isActive(ATTESTER_A);
    const callsAfterFirst = rpc.calls;
    clock.t += 29;
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: true });
    expect(rpc.calls).toBe(callsAfterFirst);
  });

  it('keeps answering active inside the window even after the chain revokes', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }]);
    const clock = { t: 1000 };
    const registry = registryOver(rpc, clock);
    await registry.isActive(ATTESTER_A);
    rpc.accounts.set(
      await entryAddress(PROGRAM_ID, 0),
      entryBytes({ measurementId: 0, attester: ATTESTER_A, revokedAt: 1_790_000_999n }),
    );
    clock.t += 10;
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: true });
  });

  it('re-reads the chain after 30 seconds, so a revoke takes effect', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }]);
    const clock = { t: 1000 };
    const registry = registryOver(rpc, clock);
    await registry.isActive(ATTESTER_A);
    rpc.accounts.set(
      await entryAddress(PROGRAM_ID, 0),
      entryBytes({ measurementId: 0, attester: ATTESTER_A, revokedAt: 1_790_000_999n }),
    );
    clock.t += 31;
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: false });
  });

  it('sees a new registration once the 5 s snapshot is stale (negatives are not cached longer)', async () => {
    const rpc = await chain([{ attester: ATTESTER_B }]);
    const clock = { t: 1000 };
    const registry = registryOver(rpc, clock);
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: false });
    rpc.accounts.set(await configAddress(PROGRAM_ID), configBytes({ nextMeasurementId: 2 }));
    rpc.accounts.set(
      await entryAddress(PROGRAM_ID, 1),
      entryBytes({ measurementId: 1, attester: ATTESTER_A }),
    );
    clock.t += 5;
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: true });
  });

  it('bounds RPC reads: many unknown attesters within 5 s cost one snapshot read', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }, { attester: ATTESTER_B }]);
    const registry = registryOver(rpc, { t: 1000 });
    for (let i = 0; i < 50; i += 1) {
      const unknown = new Uint8Array(20).fill(i);
      expect(await registry.isActive(unknown)).toEqual({ ok: true, active: false });
    }
    expect(rpc.calls).toBe(2); // one Config read + one getMultipleAccounts
  });

  it('concurrent misses share one read (single flight)', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }]);
    const registry = registryOver(rpc, { t: 1000 });
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => registry.isActive(new Uint8Array(20).fill(i + 1))),
    );
    expect(answers.every((a) => a.ok)).toBe(true);
    expect(rpc.calls).toBe(2);
  });
});

describe('createRpcRegistry robustness', () => {
  it('a read that never answers times out as ok:false', async () => {
    const hanging: RegistryRpc = {
      getAccountData: () => new Promise(() => undefined),
      getMultipleAccountData: () => new Promise(() => undefined),
    };
    const registry = createRpcRegistry({
      rpc: hanging,
      programId: PROGRAM_ID,
      now: () => 1000,
      timeoutMs: 20,
    });
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: false });
  });

  it('retries after a timed-out read (the dead read is not reused)', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }]);
    let hang = true;
    const flaky: RegistryRpc = {
      getAccountData: (addr) => (hang ? new Promise(() => undefined) : rpc.getAccountData(addr)),
      getMultipleAccountData: (addrs) => rpc.getMultipleAccountData(addrs),
    };
    const registry = createRpcRegistry({
      rpc: flaky,
      programId: PROGRAM_ID,
      now: () => 1000,
      timeoutMs: 20,
    });
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: false });
    hang = false;
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: true });
  });

  it('refuses an account with an unknown version (fails closed)', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }]);
    const bytes = entryBytes({ measurementId: 0, attester: ATTESTER_A }).slice();
    bytes[8] = 2;
    rpc.accounts.set(await entryAddress(PROGRAM_ID, 0), bytes);
    expect(await registryOver(rpc, { t: 1000 }).isActive(ATTESTER_A)).toEqual({ ok: false });
  });

  it('refuses an entry whose measurement_id differs from its PDA seed', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }]);
    rpc.accounts.set(
      await entryAddress(PROGRAM_ID, 0),
      entryBytes({ measurementId: 7, attester: ATTESTER_A }),
    );
    expect(await registryOver(rpc, { t: 1000 }).isActive(ATTESTER_A)).toEqual({ ok: false });
  });

  it.each([0, 99, 100, 149])(
    'reads past the 100-account batch limit (attester at id %i of 150)',
    async (at) => {
      const entries = Array.from({ length: 150 }, (_, id) => ({
        attester: id === at ? ATTESTER_A : ATTESTER_B,
      }));
      const rpc = await chain(entries);
      expect(await registryOver(rpc, { t: 1000 }).isActive(ATTESTER_A)).toEqual({
        ok: true,
        active: true,
      });
      expect(rpc.calls).toBe(3); // Config + two batches
    },
  );

  it('never caches an RPC failure: the next call can succeed', async () => {
    const rpc = await chain([{ attester: ATTESTER_A }]);
    const registry = registryOver(rpc, { t: 1000 });
    rpc.failing = true;
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: false });
    rpc.failing = false;
    expect(await registry.isActive(ATTESTER_A)).toEqual({ ok: true, active: true });
  });
});
