/* oxlint-disable typescript/no-unsafe-type-assertion -- test helper: cborg/peculiar return loosely typed values */
// Shared test helpers (not a .test file, not part of the public API): fixture loaders for the two
// archived devnet documents, byte-patching helpers, error assertions, and builders for the fake
// chain (SAS attestation account, EnclaveEntry account, Deployment).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import { type Address, address, getAddressEncoder } from '@solana/kit';
import { fromHex, toHex } from '@tio/encoding';
import {
  ORACLE_PROGRAM_ADDRESS,
  type EnclaveEntry,
  type EnclaveEntryArgs,
  findEnclaveEntryPda,
  findSasSignerPda,
  getEnclaveEntryDecoder,
  getEnclaveEntryEncoder,
} from '@tio/oracle-client';
import {
  SAS_ATTESTATION_DISCRIMINATOR,
  SAS_CREDENTIAL_OFFSET,
  SAS_DATA_OFFSET,
  SAS_EXPIRY_OFFSET,
  SAS_NONCE_OFFSET,
  SAS_PROGRAM_ID,
  SAS_SCHEMA_OFFSET,
  SAS_SIGNER_OFFSET,
  attestationAddress,
} from '@tio/oracle-client/attest';
import { buildPayload, sasShapedAccount } from '@tio/oracle-tests/attest';
import { decode, encode } from 'cborg';
import { expect } from 'vitest';
import type { RawAccount, ChainReader } from './chain/ports.ts';
import type { Deployment } from './deployment.ts';
import { VerifierError } from './errors.ts';

// --- fixture files -----------------------------------------------------

const repoFile = (path: string): URL => new URL(`../../${path}`, import.meta.url);

export const DOC_IDS = [0, 1] as const;
export type DocId = (typeof DOC_IDS)[number];

export const IMAGE_ID_HEX = '7dd33d974511a825c871f267ebdc6b34fb9cdc2c63210e27a31a8c7cfb96daff';
export const ATTESTER_HEX: Record<DocId, string> = {
  0: '0xc39b71ae1d2bbc0919ee8c1250728a9b2380052b',
  1: '0xb6dda6eed87322334ba37809bd451a852ae6574c',
};
export const TIMESTAMP_MS: Record<DocId, number> = { 0: 1791467660480, 1: 1791479827422 };
export const ROOT_SHA256_HEX = '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b';
export const DAY_MS = 86_400_000;

export const DOCUMENT_HEX_PATH = (id: DocId): string =>
  fileURLToPath(repoFile(`deployments/devnet/attestation-${id}.hex`));
export const COMPOSE_PATH = fileURLToPath(repoFile('enclave/docker-compose.yml'));

export function loadDocument(id: DocId): Uint8Array {
  return fromHex(readFileSync(DOCUMENT_HEX_PATH(id), 'utf8').trim());
}

export function loadDocumentHex(id: DocId): string {
  return readFileSync(DOCUMENT_HEX_PATH(id), 'utf8').trim();
}

export function loadCompose(): Uint8Array {
  return new Uint8Array(readFileSync(COMPOSE_PATH));
}

export function loadDeploymentJson(): unknown {
  return JSON.parse(readFileSync(fileURLToPath(repoFile('deployments/devnet.json')), 'utf8'));
}

// --- raw (independent) decoding of the fixtures -------------------------

export type CoseParts = {
  protectedHeader: Uint8Array;
  unprotected: Map<unknown, unknown>;
  payload: Uint8Array;
  signature: Uint8Array;
};

/** Splits a COSE_Sign1 with cborg only: the payload stays the raw bstr content. */
export function splitCose(bytes: Uint8Array): CoseParts {
  const outer = decode(bytes, { useMaps: true }) as unknown as [
    Uint8Array,
    Map<unknown, unknown>,
    Uint8Array,
    Uint8Array,
  ];
  const [protectedHeader, unprotected, payload, signature] = outer;
  return { protectedHeader, unprotected, payload, signature };
}

export function joinCose(parts: CoseParts): Uint8Array {
  return encode([parts.protectedHeader, parts.unprotected, parts.payload, parts.signature]);
}

export type RawDocument = {
  bytes: Uint8Array;
  cose: CoseParts;
  fields: Map<string, unknown>;
  certificate: Uint8Array;
  cabundle: Uint8Array[];
  pcrs: Map<number, Uint8Array>;
  publicKey: Uint8Array;
};

export function rawDocument(id: DocId): RawDocument {
  const bytes = loadDocument(id);
  const cose = splitCose(bytes);
  const fields = decode(cose.payload, { useMaps: true }) as unknown as Map<string, unknown>;
  return {
    bytes,
    cose,
    fields,
    certificate: fields.get('certificate') as Uint8Array,
    cabundle: fields.get('cabundle') as Uint8Array[],
    pcrs: fields.get('pcrs') as Map<number, Uint8Array>,
    publicKey: fields.get('public_key') as Uint8Array,
  };
}

/** The 97-byte uncompressed P-384 point (0x04 || x || y) of a certificate. */
export function certificatePoint(der: Uint8Array): Uint8Array {
  const cert = AsnConvert.parse(der, Certificate);
  return new Uint8Array(cert.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey);
}

export function serialNumberOf(der: Uint8Array): Uint8Array {
  return new Uint8Array(AsnConvert.parse(der, Certificate).tbsCertificate.serialNumber);
}

/** Independent reference for the Oyster image id: sha256(be32(0x00010007) || PCR0 || PCR1 || PCR2 || PCR16). */
export function referenceImageId(pcrs: Map<number, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0, 1, 0, 7])];
  for (const index of [0, 1, 2, 16]) {
    parts.push(pcrs.get(index) ?? new Uint8Array(0));
  }
  return sha256(Uint8Array.from(parts.flatMap((part) => [...part])));
}

// --- byte patching -----------------------------------------------------

/**
 * Returns a copy of `bytes` where, at every occurrence of `needleHex`, the byte at `offset` into
 * the match is replaced by `change(oldByte)`. Throws unless there are exactly `matches` matches, so
 * a patch can never silently become a no-op. The length never changes.
 */
export function patchBytes(
  bytes: Uint8Array,
  needleHex: string,
  offset: number,
  change: (old: number) => number,
  matches = 1,
): Uint8Array {
  const hex = toHex(bytes);
  const needle = needleHex.toLowerCase();
  const positions: number[] = [];
  for (let at = hex.indexOf(needle); at >= 0; at = hex.indexOf(needle, at + 1)) {
    if (at % 2 === 0) {
      positions.push(at / 2);
    }
  }
  if (positions.length !== matches) {
    throw new Error(`pattern ${needleHex} matched ${positions.length} times, expected ${matches}`);
  }
  const out = bytes.slice();
  for (const position of positions) {
    out[position + offset] = change(out[position + offset] ?? 0) & 0xff;
  }
  return out;
}

export const flipBit = (old: number): number => old ^ 0x01;

/** A copy with one byte changed (xor 1). */
export function flipByteAt(bytes: Uint8Array, index: number): Uint8Array {
  const out = bytes.slice();
  out[index] = (out[index] ?? 0) ^ 0x01;
  return out;
}

// --- assertions (names are in the `expect-expect` allowlist of .oxlintrc.json) ---

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The `code` of the VerifierError `fn` throws, or undefined if it does not throw. */
export function thrownCode(fn: () => unknown): string | undefined {
  const failure = caught(fn);
  return failure instanceof VerifierError ? failure.code : undefined;
}

/** `fn` throws a VerifierError with exactly this `code`. */
export function expectThrown(fn: () => unknown, code: string): void {
  const failure = caught(fn);
  expect(failure).toBeInstanceOf(VerifierError);
  expect(failure).toMatchObject({ code });
}

/** `promise` rejects with a VerifierError with exactly this `code`. */
export async function expectRejected(promise: Promise<unknown>, code: string): Promise<void> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(VerifierError);
  expect(failure).toMatchObject({ code });
}

/** The untouched input is accepted: a tamper test proves its baseline first. */
export function expectBaselineSucceeds(fn: () => unknown): void {
  expect(fn).not.toThrow();
}

// --- fake chain --------------------------------------------------------

export function fakeChain(accounts: Map<string, RawAccount>): ChainReader {
  return { account: async (at: Address) => accounts.get(at) ?? null };
}

export const CREDENTIAL = address('F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7');
export const SCHEMA = address('991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV');
export const WALLET = address('3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND');
export const OTHER_ADDRESS = address('DvDkXcQFJAvCvrMfoujKu2BWfWqVYRmL8WW9hpMgW8KC');
export const ISSUED_AT = 1_790_000_000n;
export const KIND_OYSTER_IMAGE_ID = 1;

export async function testDeployment(overrides: Partial<Deployment> = {}): Promise<Deployment> {
  const [sasSigner] = await findSasSignerPda();
  return {
    cluster: 'localnet',
    oracleProgram: ORACLE_PROGRAM_ADDRESS,
    sasProgram: SAS_PROGRAM_ID,
    credential: CREDENTIAL,
    schema: SCHEMA,
    sasSigner,
    enclaves: [],
    ...overrides,
  };
}

const addressBytes = (a: Address): Uint8Array => new Uint8Array(getAddressEncoder().encode(a));

export type SasAccountParams = {
  wallet: Address;
  credential: Address;
  schema: Address;
  signer: Address;
  payload: Uint8Array;
  expiry?: bigint;
};

/** A 256-byte SAS attestation account body (FORMATS section 7). */
export function sasAttestationAccount(p: SasAccountParams): Uint8Array {
  const data = sasShapedAccount(SAS_ATTESTATION_DISCRIMINATOR);
  data.set(addressBytes(p.wallet), SAS_NONCE_OFFSET);
  data.set(addressBytes(p.credential), SAS_CREDENTIAL_OFFSET);
  data.set(addressBytes(p.schema), SAS_SCHEMA_OFFSET);
  data.set(p.payload, SAS_DATA_OFFSET);
  data.set(addressBytes(p.signer), SAS_SIGNER_OFFSET);
  new DataView(data.buffer).setBigInt64(SAS_EXPIRY_OFFSET, p.expiry ?? 0n, true);
  return data;
}

/** Entry args consistent with fixture document `id`: image id, attester, sha256(document). */
export function entryArgsFor(
  id: DocId,
  overrides: Partial<EnclaveEntryArgs> = {},
): EnclaveEntryArgs {
  return {
    version: 1,
    bump: 255,
    measurementId: id,
    measurementKind: KIND_OYSTER_IMAGE_ID,
    measurement: fromHex(IMAGE_ID_HEX),
    attester: fromHex(ATTESTER_HEX[id].slice(2)),
    attestationDocHash: sha256(loadDocument(id)),
    registeredAt: ISSUED_AT,
    revokedAt: 0n,
    ...overrides,
  };
}

/** Account data of an EnclaveEntry (the generated encoder writes the discriminator itself). */
export function entryAccountData(id: DocId, overrides: Partial<EnclaveEntryArgs> = {}): Uint8Array {
  return new Uint8Array(getEnclaveEntryEncoder().encode(entryArgsFor(id, overrides)));
}

export function entryOf(id: DocId, overrides: Partial<EnclaveEntryArgs> = {}): EnclaveEntry {
  return getEnclaveEntryDecoder().decode(entryAccountData(id, overrides));
}

export type WalletChain = {
  chain: ChainReader;
  accounts: Map<string, RawAccount>;
  attestationAddress: Address;
  entryAddress: Address;
};

/** A fake chain holding a SAS attestation for WALLET and the EnclaveEntry it points at. */
export async function walletChain(
  id: DocId,
  options: {
    deployment?: Deployment;
    payload?: Partial<Parameters<typeof buildPayload>[0]>;
    signer?: Address;
    entry?: Partial<EnclaveEntryArgs>;
    withEntry?: boolean;
  } = {},
): Promise<WalletChain> {
  const deployment = options.deployment ?? (await testDeployment());
  const payload = buildPayload({ issuedAt: ISSUED_AT, measurementId: id, ...options.payload });
  const attestation = await attestationAddress(deployment.credential, deployment.schema, WALLET);
  const [entryAddress] = await findEnclaveEntryPda(
    { measurementId: options.payload?.measurementId ?? id },
    { programAddress: deployment.oracleProgram },
  );
  const accounts = new Map<string, RawAccount>();
  accounts.set(attestation, {
    owner: SAS_PROGRAM_ID,
    data: sasAttestationAccount({
      wallet: WALLET,
      credential: deployment.credential,
      schema: deployment.schema,
      signer: options.signer ?? deployment.sasSigner,
      payload,
      expiry: ISSUED_AT + 600n,
    }),
  });
  if (options.withEntry !== false) {
    accounts.set(entryAddress, {
      owner: deployment.oracleProgram,
      data: entryAccountData(id, options.entry),
    });
  }
  return { chain: fakeChain(accounts), accounts, attestationAddress: attestation, entryAddress };
}
