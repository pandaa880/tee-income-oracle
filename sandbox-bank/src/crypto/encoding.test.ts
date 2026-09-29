import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EncodingError,
  b64Decode,
  b64Encode,
  b64urlDecode,
  b64urlEncode,
  derToSingleLinePem,
  fromHex,
  pemToDer,
  toHex,
  utf8,
} from './encoding.ts';

function readGoldenJson(relativePath: string): unknown {
  const url = new URL(`../../../test-vectors/golden/${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

interface EccGolden {
  readonly vectors: ReadonlyArray<{
    readonly fip: {
      readonly key_material: { readonly DHPublicKey: { readonly KeyValue: string } };
    };
  }>;
}

describe('b64Encode / b64Decode', () => {
  it.each([
    [new Uint8Array([]), ''],
    [new Uint8Array([0x66]), 'Zg=='],
    [new Uint8Array([0, 1, 2]), 'AAEC'],
    [new Uint8Array([255, 254, 253, 252]), '//79/A=='],
  ] as const)('round-trips %j', (bytes, expected) => {
    expect(b64Encode(bytes)).toBe(expected);
    expect(b64Decode(expected)).toEqual(bytes);
  });

  it('rejects a non-canonical trailing-bits padding character', () => {
    // 'f' (0x66) canonically encodes to "Zg=="; 'h' carries the same top
    // data bits (10) but a non-zero low nibble (the padding bits), which a
    // strict decoder must refuse even though it decodes to the same byte.
    expect(() => b64Decode('Zh==')).toThrow(EncodingError);
  });

  it('rejects a character outside the base64 alphabet', () => {
    expect(() => b64Decode('Z!g=')).toThrow(EncodingError);
  });

  it('rejects a string whose length is not a multiple of 4', () => {
    expect(() => b64Decode('QQQ')).toThrow(EncodingError);
  });
});

describe('b64urlEncode / b64urlDecode', () => {
  it.each([
    [new Uint8Array([]), ''],
    [new Uint8Array([0x66]), 'Zg'],
    [new Uint8Array([0, 1, 2]), 'AAEC'],
    [new Uint8Array([255, 254, 253, 252]), '__79_A'],
  ] as const)('round-trips %j without padding', (bytes, expected) => {
    const encoded = b64urlEncode(bytes);
    expect(encoded).toBe(expected);
    expect(encoded.includes('=')).toBe(false);
    expect(b64urlDecode(encoded)).toEqual(bytes);
  });

  it('rejects padding', () => {
    expect(() => b64urlDecode('Zg==')).toThrow(EncodingError);
  });

  it('rejects a non-canonical trailing-bits character', () => {
    expect(() => b64urlDecode('Zh')).toThrow(EncodingError);
  });

  it('rejects a character outside the base64url alphabet', () => {
    expect(() => b64urlDecode('Z+g')).toThrow(EncodingError);
  });
});

describe('toHex / fromHex', () => {
  it('round-trips', () => {
    const bytes = new Uint8Array([0, 15, 16, 255]);
    expect(toHex(bytes)).toBe('000f10ff');
    expect(fromHex('000f10ff')).toEqual(bytes);
  });

  it('is lowercase', () => {
    expect(toHex(new Uint8Array([0xab, 0xcd]))).toBe('abcd');
  });

  it('rejects an odd-length string', () => {
    expect(() => fromHex('abc')).toThrow(EncodingError);
  });

  it('rejects a non-hex character', () => {
    expect(() => fromHex('0g')).toThrow(EncodingError);
  });
});

describe('utf8', () => {
  it('encodes ASCII to its byte values', () => {
    expect(utf8('hi')).toEqual(new Uint8Array([0x68, 0x69]));
  });

  it('encodes a multi-byte code point', () => {
    expect(utf8('€')).toEqual(new Uint8Array([0xe2, 0x82, 0xac]));
  });
});

describe('pemToDer / derToSingleLinePem', () => {
  const ecc = readGoldenJson('rahasya/ecc.json') as EccGolden;
  const vector = required(ecc.vectors[0], 'golden ecc.json must have at least one vector');
  const singleLinePem = vector.fip.key_material.DHPublicKey.KeyValue;
  const bareBase64 = singleLinePem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '');

  it('parses the single-line PEM used on the wire (wei25519 SPKI is 309 bytes)', () => {
    expect(pemToDer(singleLinePem).length).toBe(309);
  });

  it('accepts a 64-column PEM with newlines', () => {
    const lines = bareBase64.match(/.{1,64}/g) ?? [];
    const multiline = `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
    expect(pemToDer(multiline)).toEqual(pemToDer(singleLinePem));
  });

  it('accepts bare base64 with no armour', () => {
    expect(pemToDer(bareBase64)).toEqual(pemToDer(singleLinePem));
  });

  it('emits the exact single-line form rahasya requires', () => {
    const der = pemToDer(singleLinePem);
    expect(derToSingleLinePem(der)).toBe(singleLinePem);
  });

  it('round-trips der -> pem -> der', () => {
    const der = pemToDer(singleLinePem);
    expect(pemToDer(derToSingleLinePem(der))).toEqual(der);
  });
});
