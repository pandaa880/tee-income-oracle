// A whole fake devnet for page tests: pools, vaults, the registry entry, an optional attestation
// and loan for one wallet, wired into `Deps`. Not a test file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, generateKeyPairSigner, signBytes } from '@solana/kit';
import { findLoanPda, findVaultPda, getLoanDecoder } from '@tio/demo-pool-client';
import { findEnclaveEntryPda, getEnclaveEntryDecoder } from '@tio/oracle-client';
import {
  attestationAddress,
  ORACLE_PROGRAM_ID,
  parseSasAttestation,
  SAS_PROGRAM_ID,
} from '@tio/oracle-client/attest';
import { VerifierError } from '@tio/verifier/errors';
import type { Config } from '../app/config.ts';
import type { Deps } from '../app/deps.ts';
import type { GatewayPort } from '../domain/ports.ts';
import type { ChainAccount, RawAccount } from '../domain/types.ts';
import { CONFIG, fakeChain, fakeDeps, fakeGateway, fakeSources } from './fakes.ts';
import {
  CREDENTIAL,
  entry,
  hexBytes,
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
  type VerifyDocId,
  type VerifyEntryOverrides,
  verifyEntryBytes,
} from './fixtures.ts';

/** One open loan of another borrower, for the loan book. Each gets its own fresh key. */
export type BookLoanOptions = {
  pool?: 0 | 1;
  amount?: bigint;
  /** The Loan's tier byte (default 1). */
  tier?: number;
  /** Default: one hour ago, a minute earlier per entry, so entries list newest first in order. */
  borrowedAt?: bigint;
  /** The Loan's `attestation_issued_at`; default = the attestation's `issuedAt` (not re-attested). */
  loanIssuedAt?: bigint;
  /** Default: a live, fresh attestation. `false` = the borrower has none. */
  attestation?: false | { payload?: Partial<PayloadFields>; expiry?: bigint; signer?: Address };
};

export type BookLoan = { borrower: Address; loanAddress: Address; attestationAddress: Address };

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
  /** Extra registry entries by measurement id (id 0 is always there; see `revokedAt`). */
  entries?: Record<number, { revokedAt?: bigint }>;
  /** Open loans of other borrowers, readable through `poolLoans`. */
  bookLoans?: BookLoanOptions[];
  /**
   * The verify page: the wallet's attestation names build `docId`, the registry holds entries for
   * builds 0 and 1 that match the real archived documents, and the sources serve that document and
   * `enclave/docker-compose.yml` from disk. `attestation: false` still means no attestation.
   * Build 0 is revoked unless it is the verified one; build 1 is active unless it is.
   */
  verify?: {
    docId: VerifyDocId;
    /** The real compose file (default), bytes that reproduce no PCR16, or a GitHub that is down. */
    compose?: Uint8Array | 'wrong' | 'unreachable';
    entry?: VerifyEntryOverrides;
    /** Who wrote the attestation (default: the oracle's sas_signer). */
    signer?: Address;
  };
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
  for (const [id, given] of Object.entries(options.entries ?? {})) {
    const measurementId = Number(id);
    store.set((await findEnclaveEntryPda({ measurementId }))[0], {
      kind: 'enclave_entry',
      entry: entry({ measurementId, ...given }),
    });
  }
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
  const bookLoans = await addBookLoans(store, options.bookLoans ?? []);
  const raw = new Map<Address, RawAccount>();
  const verified =
    options.verify === undefined ? undefined : await addVerify(store, raw, wallet, options);
  const chain = fakeChain(store, raw);
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
      ...(verified === undefined ? {} : { sources: verified.sources }),
      ...options.overrides,
    },
  );
  return { deps, wallet, store, raw, chain, loanAddress, key, bookLoans, verified };
}

/** What `world({ verify })` set up, for assertions. */
export type Verified = Awaited<ReturnType<typeof addVerify>>;

/** The `verified` part of a world built with `verify`; throws if it was built without. */
export function verifiedOf(w: { verified: Verified | undefined }): Verified {
  if (w.verified === undefined) throw new Error('world() was built without `verify`');
  return w.verified;
}

// Built from dirname: under happy-dom `import.meta.url` is not a file URL.
const repoFile = (path: string): string => join(import.meta.dirname, '../../..', path);

async function sha256Of(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
}

async function putEntry(
  store: Map<Address, ChainAccount>,
  raw: Map<Address, RawAccount>,
  measurementId: VerifyDocId,
  data: Uint8Array,
): Promise<Address> {
  const [address] = await findEnclaveEntryPda({ measurementId });
  store.set(address, { kind: 'enclave_entry', entry: getEnclaveEntryDecoder().decode(data) });
  raw.set(address, { owner: ORACLE_PROGRAM_ID, data });
  return address;
}

async function addVerify(
  store: Map<Address, ChainAccount>,
  raw: Map<Address, RawAccount>,
  wallet: Address,
  options: WorldOptions,
) {
  const {
    docId,
    entry: overrides,
    signer,
    compose: composeOption,
  } = options.verify ?? { docId: 1 };
  const document = hexBytes(
    readFileSync(repoFile(`deployments/devnet/attestation-${docId}.hex`), 'utf8').trim(),
  );
  const compose = new Uint8Array(readFileSync(repoFile('enclave/docker-compose.yml')));
  const docHash = await sha256Of(document);

  // Builds 0 and 1 are both registered; the one the attestation names takes the overrides.
  const other = docId === 0 ? 1 : 0;
  const entryAddress = await putEntry(
    store,
    raw,
    docId,
    verifyEntryBytes(docId, docHash, overrides),
  );
  await putEntry(
    store,
    raw,
    other,
    verifyEntryBytes(
      other,
      await sha256Of(hexBytes('00')),
      other === 0 ? { revokedAt: 1_790_000_100n } : {},
    ),
  );

  const address = await attestationAddress(CREDENTIAL, SCHEMA, wallet);
  const given = options.attestation === false ? undefined : (options.attestation ?? {});
  const live = liveAttestation(given?.payload);
  const expiry = given?.expiry ?? live.expiry;
  if (given === undefined) {
    store.delete(address);
  } else {
    const bytes = sasAccountBytes({
      wallet,
      signer: signer ?? SAS_SIGNER,
      payload: payloadBytes({ ...live.payload, measurementId: docId }),
      expiry,
    });
    store.set(address, {
      kind: 'attestation',
      attestation: parseSasAttestation(SAS_PROGRAM_ID, bytes),
    });
    raw.set(address, { owner: SAS_PROGRAM_ID, data: bytes });
  }

  const composeBytes = async (): Promise<Uint8Array> => {
    if (composeOption === 'unreachable') throw new VerifierError('fetch_failed', 'GET failed');
    if (composeOption === 'wrong') return new Uint8Array([1, 2, 3]);
    return composeOption ?? compose;
  };
  return {
    document,
    compose,
    attestationAddress: address,
    entryAddress,
    issuedAt: live.payload.issuedAt,
    expiry,
    sources: fakeSources({
      archivedDocument: async () => document,
      composeAtTag: async () => composeBytes(),
    }),
  };
}

async function addBookLoans(
  store: Map<Address, ChainAccount>,
  loans: readonly BookLoanOptions[],
): Promise<BookLoan[]> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const out: BookLoan[] = [];
  for (const [index, given] of loans.entries()) {
    const { address: borrower } = await generateKeyPairSigner();
    const poolAddress = given.pool === 1 ? POOL_1 : POOL_0;
    const attestation = given.attestation === false ? undefined : (given.attestation ?? {});
    const live = liveAttestation(attestation?.payload);
    const [loanAddress] = await findLoanPda({ pool: poolAddress, borrower });
    const address = await attestationAddress(CREDENTIAL, SCHEMA, borrower);
    if (attestation !== undefined) {
      const bytes = sasAccountBytes({
        wallet: borrower,
        signer: attestation.signer ?? SAS_SIGNER,
        payload: payloadBytes(live.payload),
        expiry: attestation.expiry ?? live.expiry,
      });
      store.set(address, {
        kind: 'attestation',
        attestation: parseSasAttestation(SAS_PROGRAM_ID, bytes),
      });
    }
    store.set(loanAddress, {
      kind: 'loan',
      loan: getLoanDecoder().decode(
        loanBytes(borrower, given.amount ?? 1_000_000_000n, {
          pool: poolAddress,
          tier: given.tier ?? 1,
          borrowedAt: given.borrowedAt ?? now - 3600n - BigInt(index) * 60n,
          attestationIssuedAt: given.loanIssuedAt ?? live.payload.issuedAt,
        }),
      ),
    });
    out.push({ borrower, loanAddress, attestationAddress: address });
  }
  return out;
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
