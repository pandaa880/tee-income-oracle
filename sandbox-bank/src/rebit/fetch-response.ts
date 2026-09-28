/** FI fetch response (FORMATS §5.2), built by sandbox-bank and signed by the AA key. */

import { b64Encode } from '../crypto/encoding.ts';
import type { JsonValue } from '../crypto/jcs.ts';
import { REBIT_VERSION } from './fi-request.ts';
import type { KeyMaterial } from './key-material.ts';

export const FIP_ID = 'SANDBOX-FIP';

/** `KeyMaterial` sits on the `FI[]` entry, not in `data[]`, as in Finvu's sample. */
export function buildFetchResponse(a: {
  readonly txnid: string;
  readonly timestamp: string;
  readonly linkRefNumber: string;
  readonly maskedAccNumber: string;
  readonly encryptedFi: string;
  readonly keyMaterial: KeyMaterial;
}): JsonValue {
  return {
    ver: REBIT_VERSION,
    timestamp: a.timestamp,
    txnid: a.txnid,
    FI: [
      {
        fipID: FIP_ID,
        data: [
          {
            linkRefNumber: a.linkRefNumber,
            maskedAccNumber: a.maskedAccNumber,
            encryptedFI: a.encryptedFi,
          },
        ],
        KeyMaterial: a.keyMaterial,
      },
    ],
  };
}

/** Plaintext inside `encryptedFI`: the FI bytes plus the FIP's detached JWS over them. */
export function buildFipEnvelope(fiBytes: Uint8Array, fipJws: string): JsonValue {
  return { fi: b64Encode(fiBytes), jws: fipJws };
}
