// The verify page's reading of a verification report: what each line says, which tone it
// carries, where the links go. Pure; the facts come from the verifier's chain reads only.
import { type Address, isAddress } from '@solana/kit';
import type { Tone } from '@tio/ui/tokens';
import { type Deployment, enclaveRecordOf } from '@tio/verifier/deployment';
import type { CheckId, Verdict, VerificationReport } from '@tio/verifier/report';
import { explorerAddressUrl } from './explorer.ts';
import { formatUnixDate, hexOf, shortAddress, shortHex } from './format.ts';
import { tierTone } from './tier-tone.ts';
import type { Tier } from './types.ts';

export type CheckRow = {
  id: CheckId;
  title: string;
  /** What the check proves, in the page's words (board 9). */
  explanation: string;
  /** The library's own line: hex, ids, dates, or why it failed. */
  detail: string;
  status: 'pass' | 'fail';
};

export type VerifyFacts = {
  attestation: Address;
  explorer: string;
  writtenBy: string;
  policy: string;
  issued: string;
  expires: string;
  expired: boolean;
  build: number;
};

export type VerifyLinks = {
  /** The release whose compose file produced the build; null when the deployment file has no record. */
  release: string | null;
  /** Its tag ("v0.3.0"), for the link's label. */
  releaseTag: string | null;
  /** The archived document, at the release this page was built from. */
  archive: string | null;
  entry: string;
};

export type VerifyView = {
  tier: { letter: Tier; tone: Tone };
  facts: VerifyFacts;
  headline: string;
  verdict: Verdict;
  verdictTone: Tone;
  /** Why the verdict is FAIL although every check passed (the signer); null otherwise. */
  verdictNote: string | null;
  checks: CheckRow[];
  links: VerifyLinks;
};

export type ViewContext = {
  deployment: Deployment;
  cluster: string;
  /** The release this page was built from (the archive link points at its tree). */
  release: string;
  entryAddress: Address;
  repoUrl: string;
  nowSeconds: bigint;
};

export const CHECK_EXPLANATIONS: Record<CheckId, string> = {
  nitro_signature:
    'COSE ES384 signature and a certificate chain to the pinned AWS Nitro root (SHA-256 641a0321…8f79bb5b), valid at the document’s own time.',
  base_image:
    'PCR0–2 equal Marlin blue v3.0.0 arm64; debug enclaves have zeroed PCRs and fail here.',
  compose_pcr16:
    'PCR16 recomputed from enclave/docker-compose.yml at the build’s release tag, which pins the enclave image by digest. That tag can lag the app’s: it moves only when a new enclave build is registered.',
  image_id:
    'The image id derived from the attested PCRs equals the measurement the registry stores for this build.',
  attester:
    'keccak256 of the attested public key equals the attester in the registry entry: the only key the oracle accepts for this build.',
  doc_hash: 'SHA-256 of the archived document equals attestation_doc_hash on chain.',
  entry_active: 'Not revoked. Pools only lend on tiers from active, approved builds.',
};

const TIER_LETTERS: Record<number, Tier> = { 1: 'A', 2: 'B', 3: 'C' };

const SIGNER_NOTE = "The attestation was not written by the oracle's signer.";

/** The verifier only returns tiers 1–3 (anything else is `attestation_malformed`). */
function letterOf(tier: number): Tier {
  return TIER_LETTERS[tier] ?? 'C';
}

function writtenBy(report: VerificationReport): string {
  const { signerOk, signer } = report.attestation;
  return signerOk
    ? 'oracle signer ✓ (not a look-alike)'
    : `another signer ${shortAddress(signer)} — not the oracle`;
}

function links(report: VerificationReport, ctx: ViewContext): VerifyLinks {
  const record = enclaveRecordOf(ctx.deployment, report.attestation.measurementId);
  const tag = record?.release ?? null;
  return {
    release: tag === null ? null : `${ctx.repoUrl}/releases/tag/${tag}`,
    releaseTag: tag,
    archive:
      record === undefined
        ? null
        : `${ctx.repoUrl}/blob/${ctx.release}/deployments/${record.attestationFile}`,
    entry: explorerAddressUrl(ctx.cluster, ctx.entryAddress),
  };
}

export function verifyView(report: VerificationReport, ctx: ViewContext): VerifyView {
  const { attestation } = report;
  const checks: CheckRow[] = report.checks.map((check) => ({
    id: check.id,
    title: check.title,
    explanation: CHECK_EXPLANATIONS[check.id],
    detail: check.detail,
    status: check.status,
  }));
  const passed = checks.filter((c) => c.status === 'pass').length;
  const letter = letterOf(attestation.tier);
  const allPassed = passed === checks.length;
  return {
    tier: { letter, tone: tierTone(letter) },
    facts: {
      attestation: attestation.address,
      explorer: explorerAddressUrl(ctx.cluster, attestation.address),
      writtenBy: writtenBy(report),
      policy: shortHex(hexOf(attestation.policyHash)),
      issued: formatUnixDate(attestation.issuedAt),
      expires: formatUnixDate(attestation.expiry),
      expired: attestation.expiry < ctx.nowSeconds,
      build: attestation.measurementId,
    },
    headline: `Build #${attestation.measurementId} · ${passed} of ${checks.length} checks pass`,
    verdict: report.verdict,
    verdictTone: report.verdict === 'PASS' ? 'positive' : 'negative',
    // The checks vouch for the build; only the signer can still fail a 7/7 (report.ts).
    verdictNote: !attestation.signerOk && allPassed ? SIGNER_NOTE : null,
    checks,
    links: links(report, ctx),
  };
}

/** The wallet the reader typed, if it is one base58 address (surrounding whitespace allowed). */
export function parseWalletInput(text: string): Address | null {
  const trimmed = text.trim();
  return isAddress(trimmed) ? trimmed : null;
}
