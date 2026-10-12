/**
 * The certificate chain of a Nitro attestation document: leaf ← zonal ← regional
 * ← root, where the root must be byte-equal to the pinned AWS root
 * (`pinned.ts`). Everything is P-384 / ecdsa-with-SHA384; any other algorithm
 * is refused outright rather than "supported", so a weaker key can't sign a path.
 *
 * Order of the checks on each link (parent → child), pinned by the tests: the
 * child's algorithm OIDs, its CA / key-usage / path-length constraints, its
 * issuer name against the parent's subject, then the parent's signature over the
 * child's TBS bytes, then the child's validity at `atMs`. Structure first, so a
 * tampered constraint is reported as what it is, not as a broken signature.
 *
 * Errors name certificates by position (`root`, `cabundle[2]`, `leaf`), and the
 * parsed certificate carries the DNs only as DER: the DN is attacker-supplied text,
 * so nothing here renders it.
 */
import { p384 } from '@noble/curves/nist.js';
import { sha384 } from '@noble/hashes/sha2.js';
import { AsnConvert } from '@peculiar/asn1-schema';
import {
  BasicConstraints,
  Certificate,
  KeyUsage,
  KeyUsageFlags,
  id_ce_basicConstraints,
  id_ce_keyUsage,
} from '@peculiar/asn1-x509';
import { equalBytes } from '../bytes.ts';
import { VerifierError } from '../errors.ts';

export type ParsedCertificate = {
  der: Uint8Array;
  /** The signed bytes (TBSCertificate) exactly as they appear in `der`, never re-encoded. */
  tbs: Uint8Array;
  /** DER ECDSA signature over `tbs`. */
  signature: Uint8Array;
  /** OID of the signature algorithm (outer and inner must agree). */
  signatureAlgorithm: string;
  /** Uncompressed P-384 point, 97 bytes `0x04 ‖ x ‖ y`. */
  publicKey: Uint8Array;
  /** DER of the subject / issuer Name: matched byte for byte, never rendered (the DN is untrusted text). */
  subjectDer: Uint8Array;
  issuerDer: Uint8Array;
  notBeforeMs: number;
  notAfterMs: number;
  isCa: boolean;
  pathLen: number | undefined;
  keyUsage: { digitalSignature: boolean; keyCertSign: boolean } | undefined;
};

const OID_ECDSA_WITH_SHA384 = '1.2.840.10045.4.3.3';
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
/** DER of OID 1.3.132.0.34 (secp384r1), the SPKI parameters we accept. */
const SECP384R1_PARAMETERS = Uint8Array.of(0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22);
const UNCOMPRESSED_P384_LEN = 97;

function basicConstraints(cert: Certificate): { isCa: boolean; pathLen: number | undefined } {
  const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_ce_basicConstraints);
  if (ext === undefined) return { isCa: false, pathLen: undefined };
  const bc = AsnConvert.parse(ext.extnValue, BasicConstraints);
  return { isCa: bc.cA, pathLen: bc.pathLenConstraint };
}

function keyUsage(cert: Certificate): ParsedCertificate['keyUsage'] {
  const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_ce_keyUsage);
  if (ext === undefined) return undefined;
  const flags = AsnConvert.parse(ext.extnValue, KeyUsage).toNumber();
  return {
    digitalSignature: (flags & KeyUsageFlags.digitalSignature) !== 0,
    keyCertSign: (flags & KeyUsageFlags.keyCertSign) !== 0,
  };
}

function p384Point(cert: Certificate): Uint8Array {
  const spki = cert.tbsCertificate.subjectPublicKeyInfo;
  const point = new Uint8Array(spki.subjectPublicKey);
  const params = spki.algorithm.parameters;
  if (
    spki.algorithm.algorithm !== OID_EC_PUBLIC_KEY ||
    params === undefined ||
    params === null ||
    !equalBytes(new Uint8Array(params), SECP384R1_PARAMETERS) ||
    point.length !== UNCOMPRESSED_P384_LEN ||
    point[0] !== 0x04
  ) {
    throw new VerifierError('cert_malformed', 'public key is not an uncompressed P-384 point');
  }
  return point;
}

/** @throws VerifierError `cert_malformed` for anything that isn't a P-384 X.509 certificate. */
export function parseCertificate(der: Uint8Array): ParsedCertificate {
  let cert: Certificate;
  try {
    cert = AsnConvert.parse(der, Certificate);
  } catch {
    throw new VerifierError('cert_malformed', 'not a DER X.509 certificate');
  }
  // The parser keeps the TBS bytes as read: that is what the issuer signed (§1.2).
  const tbsRaw = cert.tbsCertificateRaw;
  if (tbsRaw === undefined) throw new VerifierError('cert_malformed', 'TBS bytes unavailable');
  try {
    const tbs = cert.tbsCertificate;
    return {
      der,
      tbs: new Uint8Array(tbsRaw),
      signature: new Uint8Array(cert.signatureValue),
      signatureAlgorithm:
        cert.signatureAlgorithm.algorithm === tbs.signature.algorithm
          ? cert.signatureAlgorithm.algorithm
          : `${cert.signatureAlgorithm.algorithm}/${tbs.signature.algorithm}`,
      publicKey: p384Point(cert),
      subjectDer: new Uint8Array(AsnConvert.serialize(tbs.subject)),
      issuerDer: new Uint8Array(AsnConvert.serialize(tbs.issuer)),
      notBeforeMs: tbs.validity.notBefore.getTime().getTime(),
      notAfterMs: tbs.validity.notAfter.getTime().getTime(),
      ...basicConstraints(cert),
      keyUsage: keyUsage(cert),
    };
  } catch (error) {
    if (error instanceof VerifierError) throw error;
    throw new VerifierError('cert_malformed', 'certificate fields could not be read');
  }
}

export type ChainInput = {
  leaf: Uint8Array;
  /** Root first, then the intermediates in signing order (what the document carries). */
  cabundle: Uint8Array[];
  pinnedRoot: Uint8Array;
  /** The instant to validate at: the document's own timestamp (the leaf lives 3 h). */
  atMs: number;
};

/** A certificate with its position in the chain, the only name errors use. */
type Positioned = { cert: ParsedCertificate; label: string };

function checkValidity({ cert, label }: Positioned, atMs: number): void {
  if (atMs < cert.notBeforeMs) {
    throw new VerifierError(
      'chain_not_yet_valid',
      `${label} not valid before ${new Date(cert.notBeforeMs).toISOString()}`,
    );
  }
  if (atMs > cert.notAfterMs) {
    throw new VerifierError(
      'chain_expired',
      `${label} expired ${new Date(cert.notAfterMs).toISOString()}`,
    );
  }
}

/** The child-side constraints of a link; `caFollowers` = CA certificates still below this one. */
function checkChildConstraints(
  { cert, label }: Positioned,
  isLeaf: boolean,
  caFollowers: number,
): void {
  if (cert.signatureAlgorithm !== OID_ECDSA_WITH_SHA384) {
    throw new VerifierError('chain_wrong_algorithm', `${label} is not ecdsa-with-SHA384`);
  }
  if (isLeaf) {
    if (cert.isCa) throw new VerifierError('chain_leaf_is_ca', `${label} is a CA`);
    if (cert.keyUsage?.digitalSignature !== true) {
      throw new VerifierError('chain_key_usage', `${label} lacks digitalSignature`);
    }
    return;
  }
  if (!cert.isCa) throw new VerifierError('chain_not_ca', `${label} is not a CA`);
  if (cert.keyUsage?.keyCertSign !== true) {
    throw new VerifierError('chain_key_usage', `${label} lacks keyCertSign`);
  }
  if (cert.pathLen !== undefined && caFollowers > cert.pathLen) {
    throw new VerifierError(
      'chain_pathlen',
      `${label} allows ${cert.pathLen} CA(s) below it, found ${caFollowers}`,
    );
  }
}

function checkLink(parent: Positioned, child: Positioned, atMs: number): void {
  if (!equalBytes(child.cert.issuerDer, parent.cert.subjectDer)) {
    throw new VerifierError(
      'chain_issuer_mismatch',
      `${child.label} is not issued by ${parent.label}`,
    );
  }
  let verified = false;
  try {
    verified = p384.verify(child.cert.signature, sha384(child.cert.tbs), parent.cert.publicKey, {
      lowS: false,
      prehash: false,
      format: 'der',
    });
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new VerifierError(
      'chain_signature_invalid',
      `${parent.label} did not sign ${child.label}`,
    );
  }
  checkValidity(child, atMs);
}

/**
 * Walks root → intermediates → leaf and returns the parsed leaf.
 *
 * @throws VerifierError `cert_malformed` | `root_not_pinned` | `chain_*`
 */
export function verifyChain(input: ChainInput): ParsedCertificate {
  const [rootDer, ...intermediateDers] = input.cabundle;
  if (rootDer === undefined || !equalBytes(rootDer, input.pinnedRoot)) {
    throw new VerifierError('root_not_pinned', 'cabundle[0] is not the pinned AWS Nitro root');
  }
  const root: Positioned = { cert: parseCertificate(rootDer), label: 'root' };
  checkValidity(root, input.atMs);
  const intermediates: Positioned[] = intermediateDers.map((der, i) => ({
    cert: parseCertificate(der),
    label: `cabundle[${i + 1}]`,
  }));
  const leaf: Positioned = { cert: parseCertificate(input.leaf), label: 'leaf' };

  let parent = root;
  intermediates.forEach((child, i) => {
    // RFC 5280 §4.2.1.9: pathLenConstraint bounds the CA certificates below this one.
    const caFollowers = intermediates.slice(i + 1).filter((c) => c.cert.isCa).length;
    checkChildConstraints(child, false, caFollowers);
    checkLink(parent, child, input.atMs);
    parent = child;
  });
  checkChildConstraints(leaf, true, 0);
  checkLink(parent, leaf, input.atMs);
  return leaf.cert;
}
