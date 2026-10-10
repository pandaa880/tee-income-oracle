// Shared test fixtures. Account bytes come from the generated Codama encoders and the SAS offsets
// in `attest.ts`, not hand-written byte arrays. Not a test file: vitest does not collect it.
import { getAddressEncoder, address, type Address } from '@solana/kit';
import { getLoanEncoder, getPoolDecoder, getPoolEncoder, type Pool } from '@tio/demo-pool-client';
import {
  getEnclaveEntryDecoder,
  getEnclaveEntryEncoder,
  type EnclaveEntry,
} from '@tio/oracle-client';
import {
  PAYLOAD_LEN,
  SAS_ATTESTATION_DISCRIMINATOR,
  SAS_ATTESTATION_LEN,
  SAS_CREDENTIAL_OFFSET,
  SAS_DATA_LEN_OFFSET,
  SAS_DATA_OFFSET,
  SAS_EXPIRY_OFFSET,
  SAS_NONCE_OFFSET,
  SAS_SCHEMA_OFFSET,
  SAS_SIGNER_OFFSET,
} from '@tio/oracle-client/attest';

// Values of deployments/devnet.json.
export const MINT: Address = address('AHDKGxzRcfers64PPHKAUi7rDMMTTcxb2nsGyUS6qXnU');
export const CREDENTIAL: Address = address('F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7');
export const SCHEMA: Address = address('991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV');
export const SAS_SIGNER: Address = address('HznYLdoTuhm53WjdvNcQBbGT71n9msXgpJcKiya2Moti');
export const ADMIN: Address = address('3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND');
export const POOL_0: Address = address('HNx4j5GqjiHpHWHZfdwa9vJVoQJfFcuHicHtGpEHtQcx');
export const POOL_1: Address = address('C4MwVjB3hDiCaAWXQsCAViM3AHHyirDkyjpRw7EzBgNn');
// The devnet relayer (/v1/info `relayer`). Not the demo_pool program id: a program can't pay fees.
export const RELAYER: Address = address('9jR2xmkX4ccCPkrH58NZPpLtSA29dQggXosyxhLFusDq');
export const OTHER: Address = address('HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8');

export const LOAN_DEPLOYMENT = { mint: MINT, credential: CREDENTIAL, schema: SCHEMA } as const;

export const POLICY_HASH = new Uint8Array(32).fill(0x11);
export const NOW = 1_790_500_000n;
export const ISSUED_AT = NOW - 1000n;
export const WINDOW_TO = 1_790_380_800;
export const WINDOW_FROM = 1_758_844_800;

const addressBytes = (a: Address): Uint8Array => new Uint8Array(getAddressEncoder().encode(a));

export type PayloadFields = {
  tier: number;
  proofType: number;
  measurementId: number;
  policyHash: Uint8Array;
  consentHash: Uint8Array;
  issuedAt: bigint;
  windowFrom: number;
  windowTo: number;
};

/** An 83-byte FORMATS §7 payload. */
export function payloadBytes(overrides: Partial<PayloadFields> = {}): Uint8Array {
  const f: PayloadFields = {
    tier: 1,
    proofType: 1,
    measurementId: 0,
    policyHash: POLICY_HASH,
    consentHash: new Uint8Array(32).fill(0x22),
    issuedAt: ISSUED_AT,
    windowFrom: WINDOW_FROM,
    windowTo: WINDOW_TO,
    ...overrides,
  };
  const out = new Uint8Array(PAYLOAD_LEN);
  const view = new DataView(out.buffer);
  out[0] = f.tier;
  out[1] = f.proofType;
  out[2] = f.measurementId;
  out.set(f.policyHash, 3);
  out.set(f.consentHash, 35);
  view.setBigInt64(67, f.issuedAt, true);
  view.setUint32(75, f.windowFrom, true);
  view.setUint32(79, f.windowTo, true);
  return out;
}

export type SasFields = { wallet: Address; payload: Uint8Array; expiry: bigint; signer: Address };

/** A 256-byte SAS attestation account (FORMATS §7). */
export function sasAccountBytes(f: Partial<SasFields> & { wallet: Address }): Uint8Array {
  const data = new Uint8Array(SAS_ATTESTATION_LEN);
  data[0] = SAS_ATTESTATION_DISCRIMINATOR;
  data.set(addressBytes(f.wallet), SAS_NONCE_OFFSET);
  data.set(addressBytes(CREDENTIAL), SAS_CREDENTIAL_OFFSET);
  data.set(addressBytes(SCHEMA), SAS_SCHEMA_OFFSET);
  const view = new DataView(data.buffer);
  view.setUint32(SAS_DATA_LEN_OFFSET, PAYLOAD_LEN, true);
  data.set(f.payload ?? payloadBytes(), SAS_DATA_OFFSET);
  data.set(addressBytes(f.signer ?? SAS_SIGNER), SAS_SIGNER_OFFSET);
  view.setBigInt64(SAS_EXPIRY_OFFSET, f.expiry ?? NOW + 10_000n, true);
  return data;
}

export type PoolParamsOverrides = Partial<Pool['params']>;

export function poolBytes(overrides: PoolParamsOverrides = {}): Uint8Array {
  return Uint8Array.from(
    getPoolEncoder().encode({
      version: 1,
      bump: 255,
      vaultBump: 254,
      poolId: 0,
      admin: ADMIN,
      mint: MINT,
      credential: CREDENTIAL,
      schema: SCHEMA,
      params: {
        policyHash: POLICY_HASH,
        tierLimits: [5_000_000n, 3_000_000n, 1_000_000n],
        maxAgeSecs: 2_592_000,
        maxWindowAgeSecs: 31_536_000,
        minWindowSecs: 7_776_000,
        approvedMeasurements: Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0b11 : 0)),
        ...overrides,
      },
    }),
  );
}

export function pool(overrides: PoolParamsOverrides = {}): Pool {
  return getPoolDecoder().decode(poolBytes(overrides));
}

export function loanBytes(borrower: Address, amount = 2_000_000n): Uint8Array {
  return Uint8Array.from(
    getLoanEncoder().encode({
      version: 1,
      bump: 255,
      tier: 1,
      pool: POOL_0,
      borrower,
      rentPayer: RELAYER,
      amount,
      borrowedAt: NOW,
      attestationIssuedAt: ISSUED_AT,
    }),
  );
}

export function entryBytes(overrides: { revokedAt?: bigint; measurementId?: number } = {}) {
  return Uint8Array.from(
    getEnclaveEntryEncoder().encode({
      version: 1,
      bump: 255,
      measurementId: overrides.measurementId ?? 0,
      measurementKind: 1,
      measurement: new Uint8Array(32).fill(7),
      attester: new Uint8Array(20).fill(0xc3),
      attestationDocHash: new Uint8Array(32).fill(9),
      registeredAt: 1_790_000_000n,
      revokedAt: overrides.revokedAt ?? 0n,
    }),
  );
}

export function entry(
  overrides: { revokedAt?: bigint; measurementId?: number } = {},
): EnclaveEntry {
  return getEnclaveEntryDecoder().decode(entryBytes(overrides));
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
