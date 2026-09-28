/** Consent artefact payload (FORMATS §5.3), signed as a compact JWS by the AA key. */

import type { JsonValue } from '../crypto/jcs.ts';

export function buildConsent(a: {
  readonly consentId: string;
  readonly status: string;
  readonly start: string;
  readonly expiry: string;
  readonly from: string;
  readonly to: string;
}): JsonValue {
  return {
    consentId: a.consentId,
    status: a.status,
    consentStart: a.start,
    consentExpiry: a.expiry,
    consentMode: 'VIEW',
    fetchType: 'ONETIME',
    consentTypes: ['TRANSACTIONS'],
    fiTypes: ['DEPOSIT'],
    FIDataRange: { from: a.from, to: a.to },
    DataLife: { unit: 'DAY', value: 0 },
  };
}
