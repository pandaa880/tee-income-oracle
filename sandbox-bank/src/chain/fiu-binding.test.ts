import { describe, expect, it } from 'vitest';

import { toHex } from '../crypto/encoding.ts';
import {
  SECP256K1_N,
  addressHex,
  attesterAddress,
  bindingMessage,
  publicJwk,
  signRecoverable,
  testKeys,
} from '../testing/fixtures.ts';
import { FIU_KEY_TAG, fiuBindingMessage, recoverAttester } from './fiu-binding.ts';

const keys = testKeys();
const jwk = publicJwk(keys.fiu);
const otherJwk = publicJwk(keys.rogue);
const enclaveKey = keys.enclaveSecp256k1;
/** Scalar 1: its address is the well-known 0x7e5f...5bdf (enclave/tests/attester.rs). */
const SCALAR_ONE = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0));

function sign(msg: Uint8Array, key = enclaveKey): Uint8Array {
  return signRecoverable(msg, key);
}

function bigToBe32(n: bigint): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * (31 - i))) & 0xffn));
}

function beToBig(bytes: Uint8Array): bigint {
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

describe('fiuBindingMessage', () => {
  it('is the 14-byte tag followed by sha256(JCS(jwk)), 46 bytes', () => {
    const msg = fiuBindingMessage(jwk);
    expect(msg).toHaveLength(46);
    expect(FIU_KEY_TAG).toBe('TIO-FIU-KEY-v1');
    expect(Buffer.from(msg.subarray(0, 14)).toString('utf8')).toBe('TIO-FIU-KEY-v1');
  });

  it('matches the independently built message', () => {
    expect(toHex(fiuBindingMessage(jwk))).toBe(toHex(bindingMessage(jwk)));
  });

  it('commits to the key: another JWK gives another message', () => {
    expect(toHex(fiuBindingMessage(jwk))).not.toBe(toHex(fiuBindingMessage(otherJwk)));
  });
});

describe('recoverAttester', () => {
  it('known answer: recovers the committed enclave test key address', () => {
    const recovered = recoverAttester(sign(bindingMessage(jwk)), jwk);
    expect(recovered).toBeDefined();
    expect(toHex(recovered ?? new Uint8Array())).toBe(toHex(attesterAddress(enclaveKey)));
  });

  it('known answer: secret scalar 1 recovers 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', () => {
    const recovered = recoverAttester(sign(bindingMessage(jwk), SCALAR_ONE), jwk);
    expect(addressHex(recovered ?? new Uint8Array())).toBe(
      '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    );
  });

  it('recovers a 20-byte address', () => {
    expect(recoverAttester(sign(bindingMessage(jwk)), jwk)).toHaveLength(20);
  });

  it('does not recover the signer when the JWK differs from the signed one', () => {
    const recovered = recoverAttester(sign(bindingMessage(jwk)), otherJwk);
    const signer = toHex(attesterAddress(enclaveKey));
    expect(recovered === undefined ? undefined : toHex(recovered)).not.toBe(signer);
  });

  it('rejects a 64-byte signature', () => {
    expect(recoverAttester(sign(bindingMessage(jwk)).subarray(0, 64), jwk)).toBeUndefined();
  });

  it('rejects a 66-byte signature', () => {
    const sig = Uint8Array.from([...sign(bindingMessage(jwk)), 0]);
    expect(recoverAttester(sig, jwk)).toBeUndefined();
  });

  it.each([27, 28, 2, 255])('rejects recovery byte v = %i (only 0 and 1 are valid)', (v) => {
    const sig = sign(bindingMessage(jwk)).slice();
    sig[64] = v;
    expect(recoverAttester(sig, jwk)).toBeUndefined();
  });

  it('rejects a high-s signature (malleated twin of a valid one)', () => {
    const sig = sign(bindingMessage(jwk)).slice();
    const s = beToBig(sig.subarray(32, 64));
    sig.set(bigToBe32(SECP256K1_N - s), 32);
    sig[64] = (sig[64] ?? 0) ^ 1; // the twin recovers the same key, so only the low-s rule stops it
    expect(recoverAttester(sig, jwk)).toBeUndefined();
  });

  it('rejects an all-zero signature', () => {
    expect(recoverAttester(new Uint8Array(65), jwk)).toBeUndefined();
  });
});
