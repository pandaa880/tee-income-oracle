/**
 * Every failure the verifier reports carries a stable code. The codes are what the
 * check details and the CLI show; messages never repeat upstream text (a certificate
 * field, a server body), only our own words and hex.
 */
export type VerifierErrorCode =
  // COSE_Sign1 envelope
  | 'cose_malformed'
  | 'cose_wrong_alg'
  | 'cose_bad_signature_length'
  | 'cose_signature_invalid'
  // attestation document (CBOR map)
  | 'document_malformed'
  // certificates and the chain to the pinned root
  | 'cert_malformed'
  | 'root_not_pinned'
  | 'chain_wrong_algorithm'
  | 'chain_not_ca'
  | 'chain_leaf_is_ca'
  | 'chain_key_usage'
  | 'chain_pathlen'
  | 'chain_issuer_mismatch'
  | 'chain_signature_invalid'
  | 'chain_not_yet_valid'
  | 'chain_expired'
  // chain reads
  | 'attestation_missing'
  | 'attestation_malformed'
  | 'entry_missing'
  | 'entry_malformed'
  // inputs
  | 'deployment_malformed'
  | 'hex_malformed'
  | 'fetch_failed'
  | 'file_unreadable';

export class VerifierError extends Error {
  readonly code: VerifierErrorCode;

  constructor(code: VerifierErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'VerifierError';
    this.code = code;
  }
}

/** The code of a VerifierError, or `fallback` for any other failure. */
export function codeOf(error: unknown, fallback: VerifierErrorCode): VerifierErrorCode {
  return error instanceof VerifierError ? error.code : fallback;
}
