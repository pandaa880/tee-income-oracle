import { describe, expect, it } from 'vitest';
import {
  bookHealthLabel,
  credentialLabel,
  credentialMessage,
  needsReattest,
} from './credential-copy.ts';
import type { CredentialStatus } from './credential.ts';

const LABELS: Record<CredentialStatus, string> = {
  valid: 'FRESH',
  none: 'NO TIER',
  stale: 'STALE',
  expired: 'EXPIRED',
  foreign_signer: 'FOREIGN SIGNER',
  enclave_revoked: 'BUILD RETIRED',
  not_approved: 'NOT APPROVED',
  policy_mismatch: 'OLD POLICY',
  tier_not_accepted: 'NOT ACCEPTED',
  window_too_old: 'STATEMENT TOO OLD',
  window_too_short: 'STATEMENT TOO SHORT',
};
const STATUSES = Object.keys(LABELS) as CredentialStatus[];

describe('credentialLabel', () => {
  it.each(STATUSES)('labels %s', (status) => {
    expect(credentialLabel(status)).toBe(LABELS[status]);
  });
});

describe('credentialMessage', () => {
  it.each(STATUSES)('has a non-empty title and detail for %s', (status) => {
    const { title, detail } = credentialMessage(status);
    expect(title.length).toBeGreaterThan(0);
    expect(detail.length).toBeGreaterThan(0);
  });

  it('gives each status its own title', () => {
    const titles = STATUSES.map((s) => credentialMessage(s).title);
    expect(new Set(titles).size).toBe(STATUSES.length);
  });
});

describe('bookHealthLabel', () => {
  const BOOK_LABELS: Record<CredentialStatus, string> = {
    valid: 'FRESH',
    none: 'NO TIER',
    stale: 'STALE · RE-ATTEST',
    expired: 'EXPIRED · RE-ATTEST',
    foreign_signer: 'FOREIGN SIGNER · RE-ATTEST',
    enclave_revoked: 'BUILD RETIRED · RE-ATTEST',
    not_approved: 'NOT APPROVED · RE-ATTEST',
    policy_mismatch: 'OLD POLICY · RE-ATTEST',
    tier_not_accepted: 'NOT ACCEPTED',
    window_too_old: 'STATEMENT TOO OLD · RE-ATTEST',
    window_too_short: 'STATEMENT TOO SHORT · RE-ATTEST',
  };

  it.each(STATUSES)('%s', (status) => {
    expect(bookHealthLabel(status)).toBe(BOOK_LABELS[status]);
  });
});

describe('needsReattest', () => {
  it.each(STATUSES)('%s', (status) => {
    const no = ['valid', 'none', 'tier_not_accepted'];
    expect(needsReattest(status)).toBe(!no.includes(status));
  });
});
