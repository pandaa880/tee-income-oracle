/** FI fetch response (FORMATS §5.2), built by sandbox-bank and signed by the AA key. */

import { b64Encode } from '../crypto/encoding.ts';
import type { JsonValue } from '../crypto/jcs.ts';
import { REBIT_VERSION } from './fi-request.ts';
import type { KeyMaterial } from './key-material.ts';

export const FIP_ID = 'SANDBOX-FIP';

/**
 * `single`: one FI entry with one account (the only shape the enclave accepts).
 * `two_fips`: two FI entries. `two_accounts`: one entry, two `data[]` items
 * sharing its KeyMaterial. The last two exist for negative vectors.
 */
export type ResponseLayout = 'single' | 'two_fips' | 'two_accounts';

/** `KeyMaterial` sits on the `FI[]` entry, not in `data[]`, as in Finvu's sample. */
export function buildFetchResponse(a: {
  readonly txnid: string;
  readonly timestamp: string;
  readonly linkRefNumber: string;
  readonly maskedAccNumber: string;
  readonly encryptedFi: string;
  readonly keyMaterial: KeyMaterial;
  readonly layout?: ResponseLayout;
}): JsonValue {
  const account = {
    linkRefNumber: a.linkRefNumber,
    maskedAccNumber: a.maskedAccNumber,
    encryptedFI: a.encryptedFi,
  };
  const entry = (data: readonly JsonValue[]): JsonValue => ({
    fipID: FIP_ID,
    data,
    KeyMaterial: a.keyMaterial,
  });
  const layout = a.layout ?? 'single';
  return {
    ver: REBIT_VERSION,
    timestamp: a.timestamp,
    txnid: a.txnid,
    FI:
      layout === 'two_fips'
        ? [entry([account]), entry([account])]
        : [entry(layoutData(layout, account))],
  };
}

function layoutData(layout: ResponseLayout, account: JsonValue): readonly JsonValue[] {
  return layout === 'two_accounts' ? [account, account] : [account];
}

/** Plaintext inside `encryptedFI`: the FI bytes plus the FIP's detached JWS over them. */
export function buildFipEnvelope(fiBytes: Uint8Array, fipJws: string): JsonValue {
  return { fi: b64Encode(fiBytes), jws: fipJws };
}
