// What a funder can check on each loan, and how far each check goes today. The statuses are
// claims about the product, so they live here, tested, not in the page.
import type { Tone } from '@tio/ui/tokens';

export type CheckStatus = 'now' | 'not_yet' | 'next';

export type FunderCheck = { claim: string; evidence: string; status: CheckStatus };

export const FUNDER_CHECKS: readonly FunderCheck[] = [
  {
    claim: "The borrower's bank cash flow passed this lender's rules",
    evidence: 'AA-signed, bank-originated data. The policy hash names the rules.',
    status: 'now',
  },
  {
    claim: 'The rules ran on published code, on real AWS Nitro hardware',
    // Describes the check, never its result: whether a build is registered is shown only from
    // the registry read (status strip, proof bar), so static copy must not assert it.
    evidence:
      "Each tier names its enclave build; the on-chain registry approves the build, and its attestation chains to AWS's root certificate.",
    status: 'now',
  },
  {
    claim: "The tier is fresh, and the rules haven't changed since",
    evidence: 'Pools refuse stale tiers and tiers from an older policy, on chain.',
    status: 'now',
  },
  {
    claim: "The same person isn't behind another wallet",
    evidence: 'Today a tier is tied to one wallet and one consented bank account.',
    status: 'not_yet',
  },
  {
    claim: 'They repaid their last loan',
    evidence: 'Repayment history that follows the wallet to the next lender.',
    status: 'next',
  },
];

const LABEL: Record<CheckStatus, string> = {
  now: 'CHECKABLE NOW',
  not_yet: 'NOT YET',
  next: 'NEXT',
};

const TONE: Record<CheckStatus, Tone> = { now: 'positive', not_yet: 'neutral', next: 'info' };

export function checkStatusLabel(status: CheckStatus): string {
  return LABEL[status];
}

export function checkStatusTone(status: CheckStatus): Tone {
  return TONE[status];
}
