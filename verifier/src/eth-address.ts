/**
 * Ethereum-style address of a secp256k1 public key: what the secp256k1
 * precompile recovers, so what the oracle registry stores as `attester`
 * (FORMATS §13).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { toHex } from '@tio/encoding';

/**
 * `keccak256(x ‖ y)[12..32]` of an uncompressed point, given either as the
 * 64-byte raw `x ‖ y` (how Oyster prints `/app/ecdsa.pub`) or as 65 bytes
 * with the `0x04` prefix.
 *
 * @throws Error on any other length or prefix.
 */
export function ethAddressFromPublicKey(pub: Uint8Array): Uint8Array {
  let point: Uint8Array;
  if (pub.length === 64) {
    point = pub;
  } else if (pub.length === 65 && pub[0] === 0x04) {
    point = pub.subarray(1);
  } else {
    throw new Error(`expected a 64-byte or 0x04-prefixed 65-byte public key, got ${pub.length}`);
  }
  return keccak_256(point).slice(12);
}

/** `0x` + lowercase hex of a 20-byte address (the form `/v1/info` uses). */
export function toEthHex(address: Uint8Array): string {
  if (address.length !== 20) throw new Error(`expected 20 bytes, got ${address.length}`);
  return `0x${toHex(address)}`;
}
