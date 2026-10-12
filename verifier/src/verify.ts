/**
 * The whole chain of custody for one wallet:
 *
 *   wallet → SAS attestation → EnclaveEntry (registry) → attestation document
 *
 * `verifyDocument` runs the seven checks of the verify page on a document and the
 * registry entry it should describe; every check runs, none short-circuits, so a
 * reader sees everything that is wrong at once. `verifyWallet` adds the two chain
 * reads. Only a wallet without an attestation (or an attestation without its
 * entry) is an error; a failing check is a `FAIL` line, never an exception.
 */
import type { Address } from '@solana/kit';
import type { EnclaveEntry } from '@tio/oracle-client';
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex } from '@tio/encoding';
import { equalBytes } from './bytes.ts';
import { type AttestationFacts, readAttestation } from './chain/attestation.ts';
import type { ChainReader } from './chain/ports.ts';
import { readEntry } from './chain/registry.ts';
import type { Deployment } from './deployment.ts';
import { VerifierError, codeOf } from './errors.ts';
import { ethAddressFromPublicKey, toEthHex } from './eth-address.ts';
import { type CoseSign1, verifyEs384 } from './nitro/cose.ts';
import { type AttestationDocument, parseAttestation } from './nitro/document.ts';
import { imageId, pcr16FromCompose } from './nitro/image-id.ts';
import {
  AWS_NITRO_ROOT_DER,
  AWS_NITRO_ROOT_SHA256,
  MARLIN_BLUE_V3_ARM64_PCRS,
} from './nitro/pinned.ts';
import { verifyChain } from './nitro/x509.ts';
import {
  CHECKS,
  type Check,
  type CheckId,
  type EntryFacts,
  type VerificationReport,
  verdictOf,
} from './report.ts';

export type DocumentInput = {
  /** The raw attestation document (COSE_Sign1 bytes). */
  document: Uint8Array;
  /** `enclave/docker-compose.yml` at the release that produced the image; absent → check 3 fails. */
  composeBytes?: Uint8Array;
  entry: EnclaveEntry;
  /** The attestation payload's `proof_type`, which must equal the entry's kind. */
  proofType: number;
};

/** Bytes given up front, or loaded once the attestation names its measurement id. */
export type ByteSource = Uint8Array | ((measurementId: number) => Promise<Uint8Array>);
export type DocumentSource = ByteSource;

export type WalletInput = {
  chain: ChainReader;
  deployment: Deployment;
  wallet: Address;
  document: DocumentSource;
  /**
   * The compose file of the build the attestation names. Absent → check 3 fails;
   * a source that throws aborts the whole verification instead (its error passes through).
   */
  composeBytes?: ByteSource;
};

type Outcome = { ok: boolean; detail: string };
type Parsed = { cose: CoseSign1; document: AttestationDocument };

const PARSE_DEPENDENT: CheckId[] = [
  'nitro_signature',
  'base_image',
  'compose_pcr16',
  'image_id',
  'attester',
  'doc_hash',
];

/** `what <actual>` on a match, `what <actual>, <expectedLabel> <expected>` otherwise. */
function compare(
  what: string,
  actual: Uint8Array,
  expected: Uint8Array,
  expectedLabel = 'registry has',
): Outcome {
  const ok = equalBytes(expected, actual);
  return {
    ok,
    detail: ok
      ? `${what} ${toHex(actual)}`
      : `${what} ${toHex(actual)}, ${expectedLabel} ${toHex(expected)}`,
  };
}

function nitroSignature({ cose, document }: Parsed): Outcome {
  try {
    const leaf = verifyChain({
      leaf: document.certificate,
      cabundle: document.cabundle,
      pinnedRoot: AWS_NITRO_ROOT_DER,
      atMs: document.timestampMs,
    });
    if (!verifyEs384(leaf.publicKey, cose)) {
      return { ok: false, detail: 'cose_signature_invalid' };
    }
  } catch (error) {
    return { ok: false, detail: codeOf(error, 'cert_malformed') };
  }
  const at = new Date(document.timestampMs).toISOString();
  return {
    ok: true,
    detail: `COSE ES384 verified; chain to pinned AWS root ${AWS_NITRO_ROOT_SHA256.slice(0, 8)}…, valid at ${at}`,
  };
}

function baseImage({ document }: Parsed): Outcome {
  const pinned = [
    MARLIN_BLUE_V3_ARM64_PCRS.pcr0,
    MARLIN_BLUE_V3_ARM64_PCRS.pcr1,
    MARLIN_BLUE_V3_ARM64_PCRS.pcr2,
  ];
  for (const [index, expected] of pinned.entries()) {
    const actual = document.pcrs.get(index) ?? new Uint8Array(0);
    if (!equalBytes(actual, expected)) {
      return {
        ok: false,
        detail: `PCR${index} ${toHex(actual)} is not Marlin blue v3.0.0 arm64 (${toHex(expected)})`,
      };
    }
  }
  return { ok: true, detail: 'PCR0–2 equal Marlin blue v3.0.0 arm64' };
}

function composePcr16({ document }: Parsed, composeBytes: Uint8Array | undefined): Outcome {
  const pcr16 = document.pcrs.get(16);
  if (pcr16 === undefined) return { ok: false, detail: 'document_malformed: no PCR16' };
  if (composeBytes === undefined) {
    return { ok: false, detail: `no compose file to recompute PCR16 ${toHex(pcr16)}` };
  }
  return compare(
    'PCR16 from docker-compose.yml',
    pcr16FromCompose(composeBytes),
    pcr16,
    'document has',
  );
}

function imageIdCheck({ document }: Parsed, entry: EnclaveEntry): Outcome {
  try {
    return compare('image id', imageId(document.pcrs), new Uint8Array(entry.measurement));
  } catch (error) {
    return { ok: false, detail: codeOf(error, 'document_malformed') };
  }
}

function attester({ document }: Parsed, entry: EnclaveEntry): Outcome {
  if (document.publicKey === null) return { ok: false, detail: 'document has no public_key' };
  let actual: Uint8Array;
  try {
    actual = ethAddressFromPublicKey(document.publicKey);
  } catch {
    return {
      ok: false,
      detail: `public_key is ${document.publicKey.length} bytes, not a secp256k1 point`,
    };
  }
  const expected = new Uint8Array(entry.attester);
  const ok = equalBytes(expected, actual);
  return {
    ok,
    detail: ok
      ? `keccak256(public_key) → ${toEthHex(actual)}`
      : `keccak256(public_key) → ${toEthHex(actual)}, registry has ${toEthHex(expected)}`,
  };
}

function docHash(bytes: Uint8Array, entry: EnclaveEntry): Outcome {
  return compare('sha256(document)', sha256(bytes), new Uint8Array(entry.attestationDocHash));
}

function entryActive(entry: EnclaveEntry, proofType: number): Outcome {
  if (entry.measurementKind !== proofType) {
    return {
      ok: false,
      detail: `entry kind ${entry.measurementKind} differs from attestation proof_type ${proofType}`,
    };
  }
  if (entry.revokedAt !== 0n) {
    return {
      ok: false,
      detail: `revoked at ${new Date(Number(entry.revokedAt) * 1000).toISOString()}`,
    };
  }
  return {
    ok: true,
    detail: `entry #${entry.measurementId} active, kind ${entry.measurementKind}`,
  };
}

function toCheck(id: CheckId, outcome: Outcome): Check {
  const title = CHECKS.find((c) => c.id === id)?.title ?? id;
  return { id, title, status: outcome.ok ? 'pass' : 'fail', detail: outcome.detail };
}

function parseOrNull(bytes: Uint8Array): { parsed: Parsed | null; code: string } {
  try {
    return { parsed: parseAttestation(bytes), code: '' };
  } catch (error) {
    return { parsed: null, code: codeOf(error, 'cose_malformed') };
  }
}

/** The seven checks of the verify page, in its order; never throws. */
export function verifyDocument(input: DocumentInput): Check[] {
  const { parsed, code } = parseOrNull(input.document);
  const last = toCheck('entry_active', entryActive(input.entry, input.proofType));
  if (parsed === null) {
    const detail = `document unreadable (${code})`;
    return [...PARSE_DEPENDENT.map((id) => toCheck(id, { ok: false, detail })), last];
  }
  return [
    toCheck('nitro_signature', nitroSignature(parsed)),
    toCheck('base_image', baseImage(parsed)),
    toCheck('compose_pcr16', composePcr16(parsed, input.composeBytes)),
    toCheck('image_id', imageIdCheck(parsed, input.entry)),
    toCheck('attester', attester(parsed, input.entry)),
    toCheck('doc_hash', docHash(input.document, input.entry)),
    last,
  ];
}

export function entryFacts(entry: EnclaveEntry): EntryFacts {
  return {
    measurementId: entry.measurementId,
    measurementKind: entry.measurementKind,
    imageId: toHex(new Uint8Array(entry.measurement)),
    attester: toEthHex(new Uint8Array(entry.attester)),
    attestationDocHash: toHex(new Uint8Array(entry.attestationDocHash)),
    registeredAt: entry.registeredAt,
    revokedAt: entry.revokedAt,
  };
}

async function resolve(
  source: ByteSource,
  measurementId: number,
  what: string,
): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  try {
    return await source(measurementId);
  } catch (error) {
    if (error instanceof VerifierError) throw error;
    throw new VerifierError('fetch_failed', `${what} source failed`);
  }
}

/**
 * Reads the wallet's attestation and the entry it names, then runs the checks.
 * The verdict is PASS only if every check passes and the attestation was
 * written by the oracle's `sas_signer` (`report.ts`).
 *
 * @throws VerifierError `attestation_missing` | `attestation_malformed` | `entry_missing` |
 *   `entry_malformed` | `deployment_malformed`; from a document or compose source: its own
 *   `VerifierError` (`file_unreadable`, `hex_malformed`, `deployment_malformed`, …), or
 *   `fetch_failed` for any other failure
 */
export async function verifyWallet(input: WalletInput): Promise<VerificationReport> {
  const attestation: AttestationFacts = await readAttestation(
    input.chain,
    input.deployment,
    input.wallet,
  );
  const entry = await readEntry(
    input.chain,
    input.deployment.oracleProgram,
    attestation.measurementId,
  );
  const id = attestation.measurementId;
  const document = await resolve(input.document, id, 'document');
  const composeBytes =
    input.composeBytes === undefined ? undefined : await resolve(input.composeBytes, id, 'compose');
  const checks = verifyDocument({
    document,
    ...(composeBytes === undefined ? {} : { composeBytes }),
    entry,
    proofType: attestation.proofType,
  });
  return {
    wallet: input.wallet,
    attestation,
    entry: entryFacts(entry),
    checks,
    verdict: verdictOf(checks, attestation),
  };
}
