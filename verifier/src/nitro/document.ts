/**
 * The attestation document inside the COSE payload (AWS Nitro Enclaves
 * "attestation document specification"): a CBOR map with `module_id`,
 * `timestamp` (ms), `digest`, `pcrs` (index → 48-byte SHA-384), `certificate`
 * (leaf DER), `cabundle` (root first), and optional `public_key`, `user_data`,
 * `nonce`. Decoded strictly: duplicate keys, a missing or mistyped field, or
 * anything that isn't a map is `document_malformed`.
 */
import { decode } from 'cborg';
import { VerifierError } from '../errors.ts';
import { type CoseSign1, decodeCoseSign1 } from './cose.ts';

export type AttestationDocument = {
  moduleId: string;
  timestampMs: number;
  digest: string;
  pcrs: Map<number, Uint8Array>;
  certificate: Uint8Array;
  cabundle: Uint8Array[];
  publicKey: Uint8Array | null;
  userData: Uint8Array | null;
  nonce: Uint8Array | null;
};

const PCR_LEN = 48;

function malformed(what: string): VerifierError {
  return new VerifierError('document_malformed', what);
}

function text(fields: Map<unknown, unknown>, key: string): string {
  const value = fields.get(key);
  if (typeof value !== 'string') throw malformed(`${key} is not text`);
  return value;
}

function bytes(fields: Map<unknown, unknown>, key: string): Uint8Array {
  const value = fields.get(key);
  if (!(value instanceof Uint8Array)) throw malformed(`${key} is not a byte string`);
  return value;
}

function optionalBytes(fields: Map<unknown, unknown>, key: string): Uint8Array | null {
  const value = fields.get(key);
  if (value === undefined || value === null) return null;
  if (!(value instanceof Uint8Array)) throw malformed(`${key} is not a byte string`);
  return value;
}

function timestamp(fields: Map<unknown, unknown>): number {
  const value = fields.get('timestamp');
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw malformed('timestamp is not an unsigned integer');
  }
  return value;
}

function pcrs(fields: Map<unknown, unknown>): Map<number, Uint8Array> {
  const value = fields.get('pcrs');
  if (!(value instanceof Map)) throw malformed('pcrs is not a map');
  const out = new Map<number, Uint8Array>();
  for (const [index, pcr] of value) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw malformed('pcr index is not an unsigned integer');
    }
    if (!(pcr instanceof Uint8Array) || pcr.length !== PCR_LEN) {
      throw malformed(`pcr ${index} is not ${PCR_LEN} bytes`);
    }
    out.set(index, pcr);
  }
  return out;
}

function cabundle(fields: Map<unknown, unknown>): Uint8Array[] {
  const value = fields.get('cabundle');
  if (!Array.isArray(value) || value.length === 0) throw malformed('cabundle is not a list');
  return value.map((cert: unknown) => {
    if (!(cert instanceof Uint8Array)) throw malformed('cabundle entry is not a byte string');
    return cert;
  });
}

/** @throws VerifierError `document_malformed` */
export function decodeAttestationDocument(payload: Uint8Array): AttestationDocument {
  let fields: unknown;
  try {
    fields = decode(payload, { useMaps: true, strict: true, rejectDuplicateMapKeys: true });
  } catch {
    throw malformed('payload is not strict CBOR');
  }
  if (!(fields instanceof Map)) throw malformed('payload is not a map');
  const digest = text(fields, 'digest');
  // The PCRs are SHA-384 values; a document naming another digest is not one we understand.
  if (digest !== 'SHA384') throw malformed('digest is not SHA384');
  return {
    moduleId: text(fields, 'module_id'),
    timestampMs: timestamp(fields),
    digest,
    pcrs: pcrs(fields),
    certificate: bytes(fields, 'certificate'),
    cabundle: cabundle(fields),
    publicKey: optionalBytes(fields, 'public_key'),
    userData: optionalBytes(fields, 'user_data'),
    nonce: optionalBytes(fields, 'nonce'),
  };
}

/** Envelope + document of the raw attestation bytes (nothing is verified yet). */
export function parseAttestation(raw: Uint8Array): {
  cose: CoseSign1;
  document: AttestationDocument;
} {
  const cose = decodeCoseSign1(raw);
  return { cose, document: decodeAttestationDocument(cose.payload) };
}
