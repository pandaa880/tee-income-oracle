/** `POST /FI/request` body (FORMATS §5.1), built by the enclave in production. */

import type { JsonValue } from '../crypto/jcs.ts';
import type { KeyMaterial } from './key-material.ts';

export const REBIT_VERSION = '1.1.3';

export function buildFiRequest(a: {
  readonly txnid: string;
  readonly timestamp: string;
  readonly consentId: string;
  readonly consentSignature: string;
  readonly from: string;
  readonly to: string;
  readonly keyMaterial: KeyMaterial;
}): JsonValue {
  return {
    ver: REBIT_VERSION,
    timestamp: a.timestamp,
    txnid: a.txnid,
    Consent: { id: a.consentId, digitalSignature: a.consentSignature },
    FIDataRange: { from: a.from, to: a.to },
    KeyMaterial: a.keyMaterial,
  };
}
