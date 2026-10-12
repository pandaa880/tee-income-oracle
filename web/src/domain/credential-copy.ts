// The words for each credential status: a badge label, a title and detail for the loan page.
import type { CredentialStatus } from './credential.ts';

type Copy = { label: string; title: string; detail: string; reattest: boolean };

const copy = (label: string, title: string, detail: string, reattest = true): Copy => ({
  label,
  title,
  detail,
  reattest,
});

const COPY: Record<CredentialStatus, Copy> = {
  valid: copy('FRESH', 'Your tier is fresh', 'This pool accepts it as it stands.', false),
  none: copy(
    'NO TIER',
    'No tier on this wallet yet',
    'Run the borrower flow once: a tier lands on Solana in under a minute.',
    false,
  ),
  stale: copy(
    'STALE',
    'Your tier needs refreshing',
    'The tier is older than this pool accepts (30 days). A fresh one takes under a minute.',
  ),
  expired: copy(
    'EXPIRED',
    'Your tier has expired',
    'The attestation passed its expiry. Re-attest to borrow again.',
  ),
  foreign_signer: copy(
    'FOREIGN SIGNER',
    'This record was not written by the oracle',
    'The attestation on this wallet carries a different signer. Re-attest to replace it.',
  ),
  enclave_revoked: copy(
    'BUILD RETIRED',
    'The enclave build that scored you was retired',
    'The enclave build that issued your tier was retired. A fresh one takes under a minute.',
  ),
  not_approved: copy(
    'NOT APPROVED',
    'This pool does not accept the enclave build that scored you',
    'The pool approves a list of enclave builds; yours is not on it. Re-attest with the current build.',
  ),
  policy_mismatch: copy(
    'OLD POLICY',
    'The pool changed its criteria',
    'Your tier was checked against older criteria. This pool only lends on tiers checked against its current ones, enforced on chain. Re-attest under the new criteria.',
  ),
  tier_not_accepted: copy(
    'NOT ACCEPTED',
    'This pool does not lend to your tier',
    'Each pool sets its own limits per tier; this one sets yours to zero. Another pool may lend.',
    false,
  ),
  window_too_old: copy(
    'STATEMENT TOO OLD',
    'The statement behind your tier is too old',
    'This pool wants a statement that ends more recently. Re-attest to fetch a newer one.',
  ),
  window_too_short: copy(
    'STATEMENT TOO SHORT',
    'The statement behind your tier covers too little time',
    'This pool wants a longer statement window than your tier was built on.',
  ),
};

/** The mono-caps chip text, e.g. "FRESH" or "OLD POLICY". */
export function credentialLabel(status: CredentialStatus): string {
  return COPY[status].label;
}

export function credentialMessage(status: CredentialStatus): { title: string; detail: string } {
  const { title, detail } = COPY[status];
  return { title, detail };
}

/** The loan book's chip: the label, plus what fixes it when a re-attest would ("STALE · RE-ATTEST"). */
export function bookHealthLabel(status: CredentialStatus): string {
  const label = credentialLabel(status);
  return needsReattest(status) ? `${label} · RE-ATTEST` : label;
}

/** Would a new attestation fix it? Not for a fresh tier, a missing one, or a pool that refuses the tier. */
export function needsReattest(status: CredentialStatus): boolean {
  return COPY[status].reattest;
}

/** The one link a "can't borrow" card offers: re-attest, get a first tier, or nothing. */
export function credentialAction(status: CredentialStatus): 'reattest' | 'get_tier' | null {
  if (status === 'none') return 'get_tier';
  return needsReattest(status) ? 'reattest' : null;
}
