import { createECDH, randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';
import { ethAddressFromPublicKey, toEthHex } from './eth-address.ts';

/** secp256k1 public key (uncompressed, 65 bytes with 0x04) for a secret key, via node:crypto. */
function uncompressedPublicKey(secret: Uint8Array): Uint8Array {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(secret);
  return new Uint8Array(ecdh.getPublicKey());
}

/** Independent reference: keccak256 of x||y, last 20 bytes. */
function referenceAddress(pub65: Uint8Array): Uint8Array {
  return keccak_256(pub65.subarray(1)).subarray(12);
}

const KEY_ONE = (() => {
  const key = new Uint8Array(32);
  key[31] = 1;
  return key;
})();
const ADDRESS_OF_KEY_ONE = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';

describe('ethAddressFromPublicKey', () => {
  it('matches_the_known_address_of_secret_key_one', () => {
    const pub65 = uncompressedPublicKey(KEY_ONE);
    expect(toEthHex(ethAddressFromPublicKey(pub65.subarray(1)))).toBe(ADDRESS_OF_KEY_ONE);
  });

  it('accepts_the_64_byte_raw_point', () => {
    const pub65 = uncompressedPublicKey(randomBytes(32));
    const address = ethAddressFromPublicKey(pub65.subarray(1));
    expect(address).toEqual(new Uint8Array(referenceAddress(pub65)));
    expect(address).toHaveLength(20);
  });

  it('accepts_the_65_byte_point_with_0x04_prefix', () => {
    const pub65 = uncompressedPublicKey(randomBytes(32));
    expect(ethAddressFromPublicKey(pub65)).toEqual(new Uint8Array(referenceAddress(pub65)));
  });

  it('gives_the_same_address_for_both_encodings', () => {
    const pub65 = uncompressedPublicKey(randomBytes(32));
    expect(ethAddressFromPublicKey(pub65)).toEqual(ethAddressFromPublicKey(pub65.subarray(1)));
  });

  it.each([0, 1, 20, 32, 33, 63, 66, 128])('rejects_length_%i', (length) => {
    expect(() => ethAddressFromPublicKey(new Uint8Array(length).fill(4))).toThrow(
      /expected a 64-byte or 0x04-prefixed/,
    );
  });

  it('rejects_65_bytes_not_starting_with_0x04', () => {
    const bad = new Uint8Array(uncompressedPublicKey(randomBytes(32)));
    bad[0] = 0x02;
    expect(() => ethAddressFromPublicKey(bad)).toThrow(/expected a 64-byte or 0x04-prefixed/);
  });
});

describe('toEthHex', () => {
  it('prefixes_0x_and_lowercases', () => {
    const bytes = new Uint8Array(20).fill(0xab);
    bytes[0] = 0xcd;
    expect(toEthHex(bytes)).toBe(`0xcd${'ab'.repeat(19)}`);
  });

  it.each([0, 19, 21, 32])('rejects_length_%i', (length) => {
    expect(() => toEthHex(new Uint8Array(length))).toThrow(/expected 20 bytes/);
  });
});
