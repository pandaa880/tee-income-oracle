/**
 * Session key derivation and AES-256-GCM (FORMATS §3), identical for both
 * key modes and byte-compatible with rahasya's CipherService:
 *   xn = ourNonce XOR theirNonce; key = HKDF-SHA256(shared, salt = xn[0..20]);
 *   iv = xn[20..32]; encryptedFI = base64(ct ‖ tag), no AAD.
 *
 * Key and cipher failures throw typed errors carrying the tio-core code
 * (like `KeyError`), because a failure here ends the whole session
 * pipeline. JWS verification returns a Result instead: its callers map
 * each code to a layer code (`bad_aa_signature`, …).
 */

import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

import { b64Decode, b64Encode } from './encoding.ts';

const NONCE_LEN = 32;
const SALT_LEN = 20;
const TAG_LEN = 16;

export interface SessionKey {
  readonly key: Uint8Array;
  readonly iv: Uint8Array;
}

export type DecryptErrorCode = 'bad_nonce' | 'decrypt_failed';

export class DecryptError extends Error {
  override readonly name = 'DecryptError';
  readonly code: DecryptErrorCode;

  constructor(code: DecryptErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.code = code;
  }
}

/**
 * Both nonces must be exactly 32 bytes: rahasya repeats a shorter remote
 * nonce cyclically, which would silently derive a different key.
 */
export function deriveSessionKey(
  shared: Uint8Array,
  ourNonce: Uint8Array,
  theirNonce: Uint8Array,
): SessionKey {
  if (ourNonce.length !== NONCE_LEN || theirNonce.length !== NONCE_LEN) {
    throw new DecryptError('bad_nonce');
  }
  const xn = ourNonce.map((b, i) => b ^ (theirNonce[i] ?? 0));
  const key = new Uint8Array(
    hkdfSync('sha256', shared, xn.subarray(0, SALT_LEN), new Uint8Array(0), 32),
  );
  return { key, iv: xn.slice(SALT_LEN) };
}

/** base64(ciphertext ‖ 16-byte tag). A key + nonce pair must never be reused. */
export function encrypt(key: SessionKey, plaintext: Uint8Array): string {
  const cipher = createCipheriv('aes-256-gcm', key.key, key.iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return b64Encode(ct);
}

/** One error for every failure, so a failure reveals nothing about which check fired. */
export function decrypt(key: SessionKey, encryptedFiB64: string): Uint8Array {
  try {
    const sealed = b64Decode(encryptedFiB64);
    if (sealed.length < TAG_LEN) {
      throw new DecryptError('decrypt_failed');
    }
    const decipher = createDecipheriv('aes-256-gcm', key.key, key.iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
    const pt = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_LEN)),
      decipher.final(),
    ]);
    return new Uint8Array(pt);
  } catch (cause) {
    throw new DecryptError('decrypt_failed', { cause });
  }
}
