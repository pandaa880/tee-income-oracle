// Fake ports and canned values for hook and adapter tests. Not a test file.
import { type Address, blockhash, getBase58Decoder } from '@solana/kit';
import { buildIntent } from '../domain/intent.ts';
import type { Config } from '../app/config.ts';
import { vi } from 'vitest';
import type { Deps } from '../app/deps.ts';
import type { BorrowerSigner, ChainPort, GatewayPort, RelayPort } from '../domain/ports.ts';
import type { AppError, ChainAccount, Info, Result } from '../domain/types.ts';
import {
  CREDENTIAL,
  MINT,
  OTHER,
  POOL_0,
  POOL_1,
  RELAYER,
  SAS_SIGNER,
  SCHEMA,
  ADMIN,
} from './fixtures.ts';

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: AppError): Result<never> => ({ ok: false, error });

export const INFO: Info = {
  cluster: 'devnet',
  oracleProgram: OTHER,
  credential: CREDENTIAL,
  schema: SCHEMA,
  measurementId: 0,
  policyHash: '11'.repeat(32),
  attesterAddress: `0x${'c3'.repeat(20)}`,
  relayer: RELAYER,
};

export const CONFIG: Config = {
  gatewayUrl: 'https://gateway.test',
  rpcUrl: 'https://rpc.test',
  cluster: 'devnet',
  deployment: {
    cluster: 'devnet',
    oracleProgram: OTHER,
    sasSigner: SAS_SIGNER,
    authority: ADMIN,
    credential: CREDENTIAL,
    schema: SCHEMA,
    mint: MINT,
    pools: [
      { address: POOL_0, poolId: 0 },
      { address: POOL_1, poolId: 1 },
    ],
  },
  features: { verify: false, book: false },
};

/** A chain whose `accounts` answers from a map keyed by address; unknown addresses are `null`. */
export function fakeChain(store: Map<Address, ChainAccount>): ChainPort {
  return {
    accounts: vi.fn<ChainPort['accounts']>(async (addresses) =>
      ok(addresses.map((a) => store.get(a) ?? null)),
    ),
    latestBlockhash: vi.fn<ChainPort['latestBlockhash']>(async () =>
      ok({
        blockhash: blockhash('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi'),
        lastValidBlockHeight: 1000n,
      }),
    ),
    signatureStatus: vi.fn<ChainPort['signatureStatus']>(async () =>
      ok({ confirmationStatus: 'confirmed', err: null }),
    ),
  };
}

/** A well-formed base58 64-byte signature (the relay adapter rejects anything else). */
export const SIG = getBase58Decoder().decode(new Uint8Array(64).fill(7));

export const SESSION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
/** Valid for the intent check: the enclave gives now + 600 s. */
export const INTENT_EXPIRES = BigInt(Math.floor(Date.now() / 1000) + 600);

export function fakeGateway(overrides: Partial<GatewayPort> = {}): GatewayPort {
  return {
    // A §9 intent for the asking wallet under the fixture pools' policy (0x11…).
    createSession: vi.fn<GatewayPort['createSession']>(async (wallet) =>
      ok({
        sessionId: SESSION_ID,
        intent: buildIntent({
          sessionId: SESSION_ID,
          wallet,
          policyHashHex: '11'.repeat(32),
          expires: INTENT_EXPIRES,
        }),
        intentExpires: INTENT_EXPIRES,
      }),
    ),
    completeSession: vi.fn<GatewayPort['completeSession']>(async function* () {
      yield* [];
    }),
    info: vi.fn<GatewayPort['info']>(async () => ok(INFO)),
    health: vi.fn<GatewayPort['health']>(async () => ok(true)),
    ...overrides,
  };
}

export function fakeRelay(signature: string = SIG): RelayPort {
  return { relay: vi.fn<RelayPort['relay']>(async () => ok(signature)) };
}

export function memoryStorage(): Deps['storage'] {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

export function fakeDeps(
  signer: BorrowerSigner,
  chain: ChainPort,
  overrides: Partial<Deps> = {},
): Deps {
  return {
    gateway: fakeGateway(),
    relay: fakeRelay(),
    chain,
    storage: memoryStorage(),
    signer,
    config: CONFIG,
    ...overrides,
  };
}
