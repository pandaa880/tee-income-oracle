import { TONES } from '@tio/ui/tokens';
import { describe, expect, it } from 'vitest';
import { credentialTone } from './credential-tone.ts';
import type { CredentialStatus } from './credential.ts';

const ALL: readonly CredentialStatus[] = [
  'none',
  'valid',
  'stale',
  'expired',
  'foreign_signer',
  'enclave_revoked',
  'not_approved',
  'policy_mismatch',
  'tier_not_accepted',
  'window_too_old',
  'window_too_short',
];

describe('credentialTone', () => {
  it('maps every status to a tone from the design system', () => {
    for (const status of ALL) expect(TONES).toContain(credentialTone(status));
  });

  it('pins the clear cases', () => {
    expect(credentialTone('valid')).toBe('positive');
    expect(credentialTone('none')).toBe('neutral');
    expect(credentialTone('stale')).toBe('caution');
    expect(credentialTone('enclave_revoked')).toBe('negative');
  });
});
