// Test code only. Builds text that mimics `oyster-cvm` 5.0.1 (tracing_subscriber fmt on stdout)
// so the parsers and `runRotate` are tested without the CLI, and a deterministic secp256k1
// identity standing in for an enclave's per-boot attester key.
import { createECDH, createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { toHex } from '@tio/encoding';

const STAMP = '2026-10-08T10:00:00.123456Z';
const ESC = String.fromCharCode(27);

export { toHex };

export function logLine(module: string, message: string, level = ' INFO', colour = false): string {
  if (!colour) return `${STAMP} ${level} oyster_cvm::commands::${module}: ${message}`;
  return `${ESC}[2m${STAMP}${ESC}[0m ${ESC}[32m${level}${ESC}[0m ${ESC}[2moyster_cvm::commands::${module}${ESC}[0m${ESC}[2m:${ESC}[0m ${message}`;
}

/** `oyster-cvm compute-image-id` stdout. */
export function computeImageIdOutput(imageIdHex: string, colour = false): string {
  return [
    logLine('compute_image_id', 'Computing image id for docker-compose.yml', ' INFO', colour),
    logLine('compute_image_id', `Image ID: ${imageIdHex}`, ' INFO', colour),
  ].join('\n');
}

export type VerifyOutputOptions = {
  enclavePublicKeyHex: string;
  imageIdHex: string;
  colour?: boolean;
  /** Drop the `Verification successful` line (and the expectations line). */
  omitSuccess?: boolean;
  omitPublicKey?: boolean;
  omitImageId?: boolean;
  /** Extra lines appended, e.g. an ERROR level line. */
  extraLines?: string[];
};

/** `oyster-cvm verify` stdout in the order of verify.rs. */
export function verifyOutput(o: VerifyOutputOptions): string {
  const c = o.colour === true;
  const line = (message: string, level = ' INFO') => logLine('verify', message, level, c);
  const lines = [
    line(`Root public key: ${'11'.repeat(97)}`),
    ...(o.omitPublicKey === true ? [] : [line(`Enclave public key: ${o.enclavePublicKeyHex}`)]),
    ...(o.omitImageId === true ? [] : [line(`Image id: ${o.imageIdHex}`)]),
    line('User data: '),
    line(`PCR0: ${'00'.repeat(48)}`),
    line(`PCR1: ${'00'.repeat(48)}`),
    line(`PCR2: ${'00'.repeat(48)}`),
    line(`PCR16: ${'00'.repeat(48)}`),
    ...(o.omitSuccess === true
      ? []
      : [line('Verification successful ✓'), line('Verified against expectations: ')]),
    ...(o.extraLines ?? []),
  ];
  return lines.join('\n');
}

export type FakeEnclave = {
  /** Raw x||y point, 64 bytes (what oyster-cvm prints, no 0x04). */
  publicKey64: Uint8Array;
  publicKeyHex: string;
  /** keccak256(x||y)[12..32] */
  attester: Uint8Array;
  attesterHex: string;
  imageIdHex: string;
};

/** Deterministic enclave identity from a one-byte seed; independent of the code under test. */
export function fakeEnclave(seed: number): FakeEnclave {
  const secret = new Uint8Array(32).fill(0);
  secret[31] = seed;
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(secret);
  const publicKey64 = new Uint8Array(ecdh.getPublicKey()).subarray(1);
  const attester = keccak_256(publicKey64).subarray(12);
  return {
    publicKey64,
    publicKeyHex: toHex(publicKey64),
    attester,
    attesterHex: `0x${toHex(attester)}`,
    imageIdHex: createHash('sha256').update(`image-${seed}`).digest('hex'),
  };
}

/** A pinned compose file that is not a template: real-looking registry and digest. */
export function composeWithDigest(digestHex: string): string {
  return [
    '# test compose',
    'services:',
    '  enclave:',
    `    image: docker.io/tio/tio-enclave@sha256:${digestHex}`,
    '    network_mode: host',
    '',
  ].join('\n');
}

export const PLACEHOLDER_COMPOSE = [
  'services:',
  '  enclave:',
  '    image: docker.io/REPLACE_ME/tio-enclave@sha256:' + '0'.repeat(64),
  '',
].join('\n');

/** Bytes a fake attestation hex file decodes to; `docHash` is sha256 of these. */
export function fakeAttestationHex(seed: number): string {
  return toHex(createHash('sha256').update(`attestation-${seed}`).digest());
}
