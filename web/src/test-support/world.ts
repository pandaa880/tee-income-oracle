// A whole fake devnet for page tests: pools, vaults, the registry entry, an optional attestation
// and loan for one wallet, wired into `Deps`. Not a test file.
import { type Address, generateKeyPairSigner, signBytes } from '@solana/kit';
import { findLoanPda, findVaultPda, getLoanDecoder } from '@tio/demo-pool-client';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress, parseSasAttestation, SAS_PROGRAM_ID } from '@tio/oracle-client/attest';
import type { Config } from '../app/config.ts';
import type { Deps } from '../app/deps.ts';
import type { GatewayPort } from '../domain/ports.ts';
import type { ChainAccount } from '../domain/types.ts';
import { CONFIG, fakeChain, fakeDeps, fakeGateway } from './fakes.ts';
import {
  CREDENTIAL,
  entry,
  loanBytes,
  type PayloadFields,
  payloadBytes,
  pool,
  POOL_0,
  POOL_1,
  type PoolParamsOverrides,
  SAS_SIGNER,
  SCHEMA,
  sasAccountBytes,
  tokenAccount,
} from './fixtures.ts';

export type WorldOptions = {
  /** Present by default (tier A, fresh). `false` = the wallet has no attestation. */
  attestation?: false | { payload?: Partial<PayloadFields>; expiry?: bigint };
  poolParams?: PoolParamsOverrides;
  /** Extra params for pool 1 only, on top of `poolParams`. */
  poolParams1?: PoolParamsOverrides;
  /** Per-pool vault balance in base units (default 9,000 tokens, above every test limit). */
  vault?: { 0?: bigint; 1?: bigint };
  /** An open Loan on pool 0 with this principal. */
  loan?: bigint;
  revokedAt?: bigint;
  gateway?: Partial<GatewayPort>;
  features?: Config['features'];
  overrides?: Partial<Deps>;
};

export async function world(options: WorldOptions = {}) {
  const key = await generateKeyPairSigner();
  const wallet = key.address;
  const store = new Map<Address, ChainAccount>();
  const pools = [
    { address: POOL_0, vault: options.vault?.[0], params: options.poolParams },
    {
      address: POOL_1,
      vault: options.vault?.[1],
      params: { ...options.poolParams, ...options.poolParams1 },
    },
  ];
  for (const { address, vault: balance, params } of pools) {
    store.set(address, { kind: 'pool', pool: pool({ ...params }) });
    const [vault] = await findVaultPda({ pool: address });
    store.set(vault, { kind: 'token', token: tokenAccount({ amount: balance ?? 9_000_000_000n }) });
  }
  store.set((await findEnclaveEntryPda({ measurementId: 0 }))[0], {
    kind: 'enclave_entry',
    entry: entry({ revokedAt: options.revokedAt ?? 0n }),
  });
  if (options.attestation !== false) {
    const given = options.attestation ?? {};
    const bytes = sasAccountBytes({
      wallet,
      signer: SAS_SIGNER,
      payload: payloadBytes(given.payload),
      ...(given.expiry === undefined ? {} : { expiry: given.expiry }),
    });
    store.set(await attestationAddress(CREDENTIAL, SCHEMA, wallet), {
      kind: 'attestation',
      attestation: parseSasAttestation(SAS_PROGRAM_ID, bytes),
    });
  }
  const [loanAddress] = await findLoanPda({ pool: POOL_0, borrower: wallet });
  if (options.loan !== undefined) {
    store.set(loanAddress, {
      kind: 'loan',
      loan: getLoanDecoder().decode(loanBytes(wallet, options.loan)),
    });
  }
  const chain = fakeChain(store);
  const config: Config = { ...CONFIG, features: options.features ?? CONFIG.features };
  const deps = fakeDeps(
    {
      address: wallet,
      signIntent: (bytes) => signBytes(key.keyPair.privateKey, bytes),
      signer: key,
    },
    chain,
    {
      config,
      gateway: fakeGateway(options.gateway),
      ...options.overrides,
    },
  );
  return { deps, wallet, store, chain, loanAddress, key };
}

/** Attestation options for a record that is fresh relative to the real clock (page tests). */
export function liveAttestation(overrides: Partial<PayloadFields> = {}) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const windowTo = Number(now) - 86_400;
  return {
    payload: {
      issuedAt: now - 1000n,
      windowTo,
      windowFrom: windowTo - 7_776_000 - 86_400,
      ...overrides,
    },
    expiry: now + 100_000n,
  };
}
