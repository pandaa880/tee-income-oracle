import type { Tone } from '@tio/ui/tokens';
import type { CredentialStatus } from './credential.ts';

/** Anything that needs a re-attest reads as caution or worse. */
const CREDENTIAL_TONE: Record<CredentialStatus, Tone> = {
  valid: 'positive',
  none: 'neutral',
  stale: 'caution',
  expired: 'caution',
  policy_mismatch: 'caution',
  not_approved: 'accent',
  tier_not_accepted: 'accent',
  window_too_old: 'caution',
  window_too_short: 'caution',
  foreign_signer: 'negative',
  enclave_revoked: 'negative',
};

/** Credential health → colour role. */
export function credentialTone(status: CredentialStatus): Tone {
  return CREDENTIAL_TONE[status];
}
