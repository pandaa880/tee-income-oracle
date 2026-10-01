import { describe, expect, it } from 'vitest';
import {
  base58Decode,
  base58Encode,
  buildMessage,
  buildPayload,
  type PayloadFields,
} from './payload.ts';

// Layouts are written out here from FORMATS §7 / §8, field by field, never by
// calling the builders: a second, independent statement of the byte layout.

const ORACLE_ID = 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

function bytes(...parts: readonly (readonly number[])[]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

function repeat(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}

/** 0x01, 0x02, ... 0x20. */
const POLICY_HASH = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
/** 0x80, 0x81, ... 0x9f. */
const CONSENT_HASH = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);

const FIELDS: PayloadFields = {
  tier: 'B',
  proofType: 1,
  measurementId: 0x2a,
  policyHash: POLICY_HASH,
  consentHash: CONSENT_HASH,
  issuedAt: 0x0102030405060708n,
  windowFrom: 0x11223344,
  windowTo: 0x55667788,
};

function expectedPayload(): Uint8Array {
  return bytes(
    [2, 1, 0x2a],
    [...POLICY_HASH],
    [...CONSENT_HASH],
    [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01],
    [0x44, 0x33, 0x22, 0x11],
    [0x88, 0x77, 0x66, 0x55],
  );
}

describe('buildPayload', () => {
  it('matches the hand-assembled 83-byte table', () => {
    const payload = buildPayload(FIELDS);
    expect(payload).toHaveLength(83);
    expect(payload).toEqual(expectedPayload());
  });

  it.each([
    ['A', 1],
    ['B', 2],
    ['C', 3],
  ] as const)('writes tier %s as byte %i at offset 0', (tier, byte) => {
    expect(buildPayload({ ...FIELDS, tier })[0]).toBe(byte);
  });

  it('writes proof_type at offset 1 and measurement_id at offset 2', () => {
    const payload = buildPayload({ ...FIELDS, proofType: 1, measurementId: 0xff });
    expect(payload[1]).toBe(1);
    expect(payload[2]).toBe(0xff);
  });

  it('puts policy_hash at 3..35 and consent_hash at 35..67', () => {
    const payload = buildPayload(FIELDS);
    expect(payload.subarray(3, 35)).toEqual(POLICY_HASH);
    expect(payload.subarray(35, 67)).toEqual(CONSENT_HASH);
  });

  it('writes issued_at as i64 little-endian at 67', () => {
    expect(buildPayload(FIELDS).subarray(67, 75)).toEqual(
      bytes([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]),
    );
  });

  it('writes a negative issued_at in two’s complement', () => {
    const payload = buildPayload({ ...FIELDS, issuedAt: -2n });
    expect(payload.subarray(67, 75)).toEqual(bytes([0xfe], repeat(0xff, 7)));
  });

  it('writes i64 minimum as a lone 0x80 top byte', () => {
    const payload = buildPayload({ ...FIELDS, issuedAt: -(2n ** 63n) });
    expect(payload.subarray(67, 75)).toEqual(bytes(repeat(0, 7), [0x80]));
  });

  it('writes window_from and window_to as u32 little-endian at 75 and 79', () => {
    const payload = buildPayload(FIELDS);
    expect(payload.subarray(75, 79)).toEqual(bytes([0x44, 0x33, 0x22, 0x11]));
    expect(payload.subarray(79, 83)).toEqual(bytes([0x88, 0x77, 0x66, 0x55]));
  });

  it('writes u32 maximum windows as 0xff bytes (no sign extension)', () => {
    const payload = buildPayload({ ...FIELDS, windowFrom: 0xffffffff, windowTo: 0xffffffff });
    expect(payload.subarray(75, 83)).toEqual(bytes(repeat(0xff, 8)));
  });

  it('writes zero windows as zero bytes', () => {
    const payload = buildPayload({ ...FIELDS, windowFrom: 0, windowTo: 0 });
    expect(payload.subarray(75, 83)).toEqual(bytes(repeat(0, 8)));
  });

  it('rejects a hash that is not 32 bytes', () => {
    expect(() => buildPayload({ ...FIELDS, policyHash: new Uint8Array(31) })).toThrow();
    expect(() => buildPayload({ ...FIELDS, consentHash: new Uint8Array(33) })).toThrow();
  });

  it('rejects a window outside u32', () => {
    expect(() => buildPayload({ ...FIELDS, windowTo: 0x100000000 })).toThrow();
    expect(() => buildPayload({ ...FIELDS, windowFrom: -1 })).toThrow();
  });

  it('rejects an issued_at outside i64', () => {
    expect(() => buildPayload({ ...FIELDS, issuedAt: 2n ** 63n })).toThrow();
  });
});

const CTX = {
  oracleProgramId: Uint8Array.from(repeat(0x11, 32)),
  sasCredential: Uint8Array.from(repeat(0x22, 32)),
  sasSchema: Uint8Array.from(repeat(0x33, 32)),
};
const WALLET = Uint8Array.from(repeat(0x44, 32));
const EXPIRY = 0x1112131415161718n;

function expectedMessage(expiryLe: readonly number[]): Uint8Array {
  return bytes(
    [...new TextEncoder().encode('TIO-ATTEST-v1')],
    repeat(0x11, 32),
    repeat(0x22, 32),
    repeat(0x33, 32),
    repeat(0x44, 32),
    [...expectedPayload()],
    expiryLe,
  );
}

describe('buildMessage', () => {
  const payload = buildPayload(FIELDS);

  it('matches the hand-assembled 232-byte layout', () => {
    const message = buildMessage(CTX, WALLET, payload, EXPIRY);
    expect(message).toHaveLength(232);
    expect(message).toEqual(expectedMessage([0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11]));
  });

  it('starts with the 13-byte domain tag', () => {
    const message = buildMessage(CTX, WALLET, payload, EXPIRY);
    expect(new TextDecoder().decode(message.subarray(0, 13))).toBe('TIO-ATTEST-v1');
  });

  it('places program, credential, schema, wallet at 13, 45, 77, 109', () => {
    const message = buildMessage(CTX, WALLET, payload, EXPIRY);
    expect(message.subarray(13, 45)).toEqual(CTX.oracleProgramId);
    expect(message.subarray(45, 77)).toEqual(CTX.sasCredential);
    expect(message.subarray(77, 109)).toEqual(CTX.sasSchema);
    expect(message.subarray(109, 141)).toEqual(WALLET);
  });

  it('places the payload at 141..224 and expiry (i64 LE) at 224..232', () => {
    const message = buildMessage(CTX, WALLET, payload, EXPIRY);
    expect(message.subarray(141, 224)).toEqual(payload);
    expect(message.subarray(224, 232)).toEqual(
      bytes([0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11]),
    );
  });

  it('writes a negative expiry in two’s complement', () => {
    const message = buildMessage(CTX, WALLET, payload, -1n);
    expect(message.subarray(224, 232)).toEqual(bytes(repeat(0xff, 8)));
  });

  it('rejects a wallet or id that is not 32 bytes', () => {
    expect(() => buildMessage(CTX, new Uint8Array(31), payload, EXPIRY)).toThrow();
    expect(() =>
      buildMessage({ ...CTX, sasSchema: new Uint8Array(33) }, WALLET, payload, EXPIRY),
    ).toThrow();
  });

  it('rejects a payload that is not 83 bytes', () => {
    expect(() => buildMessage(CTX, WALLET, new Uint8Array(82), EXPIRY)).toThrow();
  });
});

describe('base58Encode / base58Decode', () => {
  it('encodes 32 zero bytes as the system program id', () => {
    expect(base58Encode(new Uint8Array(32))).toBe(SYSTEM_PROGRAM);
  });

  it('decodes the system program id to 32 zero bytes', () => {
    expect(base58Decode(SYSTEM_PROGRAM)).toEqual(new Uint8Array(32));
  });

  it('round-trips the Anchor.toml oracle program id through 32 bytes', () => {
    const decoded = base58Decode(ORACLE_ID);
    expect(decoded).toHaveLength(32);
    expect(base58Encode(decoded)).toBe(ORACLE_ID);
  });

  it('matches the Bitcoin-alphabet vector for "Hello World!"', () => {
    const text = new TextEncoder().encode('Hello World!');
    expect(base58Encode(text)).toBe('2NEpo7TZRRrLZSi2U');
    expect(base58Decode('2NEpo7TZRRrLZSi2U')).toEqual(text);
  });

  it('encodes the empty array as the empty string and back', () => {
    expect(base58Encode(new Uint8Array(0))).toBe('');
    expect(base58Decode('')).toEqual(new Uint8Array(0));
  });

  it('encodes 0xff as "5Q"', () => {
    expect(base58Encode(Uint8Array.of(0xff))).toBe('5Q');
    expect(base58Decode('5Q')).toEqual(Uint8Array.of(0xff));
  });

  it('keeps one "1" per leading zero byte', () => {
    expect(base58Encode(Uint8Array.of(0))).toBe('1');
    expect(base58Encode(Uint8Array.of(0, 0, 1))).toBe('112');
    expect(base58Decode('112')).toEqual(Uint8Array.of(0, 0, 1));
    expect(base58Decode('11')).toEqual(Uint8Array.of(0, 0));
  });

  it('round-trips a value with leading zeros in the middle of a 32-byte key', () => {
    const key = Uint8Array.from([0, 0, 0, ...repeat(0xab, 29)]);
    expect(base58Decode(base58Encode(key))).toEqual(key);
  });

  it.each(['0', 'O', 'I', 'l', '+', '/', ' ', 'abc0def', 'é'])(
    'rejects the character set outside the alphabet: %j',
    (text) => {
      expect(() => base58Decode(text)).toThrow();
    },
  );
});
