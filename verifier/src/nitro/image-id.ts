/**
 * Marlin Oyster's image id and its PCR16 commitment, as `oyster-cvm` 5.0.1
 * computes them (cli/oyster-cvm/src/commands/image_id.rs). The image id is
 * what the oracle registry stores as `measurement` (FORMATS §13, kind 1), so
 * reproducing it here from the attested PCRs is what ties a registry entry to a
 * concrete base image (PCR0–2) and a concrete docker-compose file (PCR16).
 */
import { sha256, sha384 } from '@noble/hashes/sha2.js';
import { VerifierError } from '../errors.ts';

/** Domain prefix `oyster-cvm` hashes before the PCRs (big-endian u32). */
export const OYSTER_IMAGE_ID_PREFIX = 0x00010007;
/** The init-params path the compose file is loaded under inside the enclave. */
export const COMPOSE_INIT_PARAM_PATH = '/init-params/docker-compose.yml';
const IMAGE_ID_PCRS = [0, 1, 2, 16] as const;
const PCR_LEN = 48;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function be32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function u64le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

/**
 * `sha256(be32(0x00010007) ‖ PCR0 ‖ PCR1 ‖ PCR2 ‖ PCR16)`.
 *
 * @throws VerifierError `document_malformed` if one of those PCRs is missing or not 48 bytes.
 */
export function imageId(pcrs: Map<number, Uint8Array>): Uint8Array {
  const parts = IMAGE_ID_PCRS.map((index) => {
    const pcr = pcrs.get(index);
    if (pcr === undefined || pcr.length !== PCR_LEN) {
      throw new VerifierError('document_malformed', `pcr ${index} missing or not ${PCR_LEN} bytes`);
    }
    return pcr;
  });
  return sha256(concat([be32(OYSTER_IMAGE_ID_PREFIX), ...parts]));
}

/**
 * PCR16 as the Oyster init process extends it for the compose init param:
 * `sha384(0⁴⁸ ‖ sha256(sha256(u64le(len P) ‖ P ‖ u64le(len C) ‖ C)))` with
 * P = `/init-params/docker-compose.yml` and C = the compose bytes. Every byte of
 * the compose file counts (comments included), which is why the file pins the
 * enclave image by digest.
 */
export function pcr16FromCompose(compose: Uint8Array): Uint8Array {
  const path = new TextEncoder().encode(COMPOSE_INIT_PARAM_PATH);
  const params = sha256(sha256(concat([u64le(path.length), path, u64le(compose.length), compose])));
  return sha384(concat([new Uint8Array(PCR_LEN), params]));
}
