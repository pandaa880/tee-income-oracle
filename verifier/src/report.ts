/**
 * The verification report: the seven checks of the verify page (board 9), in
 * its order and with its titles, plus the facts read from the chain. Details
 * hold hex, ids, dates and our own error codes only.
 */
import type { Address } from '@solana/kit';
import type { AttestationFacts } from './chain/attestation.ts';

export type CheckId =
  | 'nitro_signature'
  | 'base_image'
  | 'compose_pcr16'
  | 'image_id'
  | 'attester'
  | 'doc_hash'
  | 'entry_active';

export const CHECKS: ReadonlyArray<{ id: CheckId; title: string }> = [
  { id: 'nitro_signature', title: 'Signed by AWS Nitro hardware' },
  { id: 'base_image', title: "Marlin's published base image, not debug mode" },
  { id: 'compose_pcr16', title: 'Runs our published code' },
  { id: 'image_id', title: 'Image id matches the registry' },
  { id: 'attester', title: 'Enclave key = on-chain attester' },
  { id: 'doc_hash', title: 'Same document the registry recorded' },
  { id: 'entry_active', title: 'Entry is active' },
];

export type CheckStatus = 'pass' | 'fail';

export type Check = { id: CheckId; title: string; status: CheckStatus; detail: string };

export type EntryFacts = {
  measurementId: number;
  measurementKind: number;
  /** Hex image id. */
  imageId: string;
  /** `0x` + hex. */
  attester: string;
  /** Hex. */
  attestationDocHash: string;
  registeredAt: bigint;
  revokedAt: bigint;
};

export type Verdict = 'PASS' | 'FAIL';

export type VerificationReport = {
  wallet: Address;
  attestation: AttestationFacts;
  entry: EntryFacts;
  checks: Check[];
  verdict: Verdict;
};

/**
 * PASS needs every check and an attestation the oracle wrote (`signerOk`): the
 * seven checks vouch for the registry entry, and only the oracle's `sas_signer`
 * ties the tier to that entry's precompile check (FORMATS §13).
 */
export function verdictOf(
  checks: Check[],
  attestation: Pick<AttestationFacts, 'signerOk'>,
): Verdict {
  return attestation.signerOk && checks.every((c) => c.status === 'pass') ? 'PASS' : 'FAIL';
}

const TIER_LETTERS: Record<number, string> = { 1: 'A', 2: 'B', 3: 'C' };

function date(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 10);
}

function expiryNote(expiry: bigint, nowMs: number): string {
  return BigInt(Math.floor(nowMs / 1000)) > expiry ? ' (EXPIRED)' : '';
}

/** One `PASS`/`FAIL` line per check and a `VERDICT` line last (the CLI's output). */
export function formatReport(report: VerificationReport, nowMs = Date.now()): string {
  const { attestation: a, entry: e } = report;
  const lines = [
    `wallet       ${report.wallet}`,
    `attestation  ${a.address}`,
    `written by   ${a.signerOk ? 'oracle sas_signer' : `UNEXPECTED signer ${a.signer} (not the oracle: verdict FAIL)`}`,
    `tier         ${TIER_LETTERS[a.tier] ?? a.tier}  issued ${date(a.issuedAt)}  expires ${date(a.expiry)}${expiryNote(a.expiry, nowMs)}`,
    `enclave      #${e.measurementId}  attester ${e.attester}  ${e.revokedAt === 0n ? 'active' : `revoked at ${date(e.revokedAt)}`}`,
    '',
    ...report.checks.map(
      (c) => `${c.status === 'pass' ? 'PASS' : 'FAIL'}  ${c.title} — ${c.detail}`,
    ),
    '',
    `VERDICT ${report.verdict}`,
  ];
  return `${lines.join('\n')}\n`;
}
