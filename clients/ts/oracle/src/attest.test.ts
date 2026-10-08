// Unit tests for the hand-written attestation helpers (`attest.ts`): the parts Codama cannot
// generate (FORMATS §8 message, precompile data, SAS attestation address and reader, constants).
import { getAddressEncoder, address, type Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { SAS_PROGRAM_ID as OPS_SAS_PROGRAM_ID } from '../../../../ops/src/sas-schema.ts';
import {
  buildPayload,
  buildPrecompileData as testBuildPrecompileData,
  enclaveKey,
  sasShapedAccount,
  signMessage,
} from '../../../../programs/oracle/tests/src/attest.ts';
import { ORACLE_PROGRAM_ADDRESS } from './generated/index.ts';
import {
  DOMAIN_TAG,
  MAX_SIGNATURE_LIFETIME_SECS,
  MESSAGE_LEN,
  ORACLE_PROGRAM_ID,
  PAYLOAD_LEN,
  PRECOMPILE_DATA_LEN,
  SAS_ATTESTATION_DISCRIMINATOR,
  SAS_ATTESTATION_LEN,
  SAS_CREDENTIAL_OFFSET,
  SAS_DATA_LEN_OFFSET,
  SAS_DATA_OFFSET,
  SAS_EXPIRY_OFFSET,
  SAS_NONCE_OFFSET,
  SAS_PROGRAM_ID,
  SAS_SCHEMA_OFFSET,
  SAS_SIGNER_OFFSET,
  SECP256K1_PROGRAM,
  attestationAddress,
  buildMessage,
  buildPrecompileData,
  parseSasAttestation,
  payloadIssuedAt,
  precompileInstruction,
} from './attest.ts';

const PROGRAM = address('HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8');
const CREDENTIAL = address('F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7');
const SCHEMA = address('991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV');
const WALLET = address('3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND');
const ISSUED_AT = 1_790_000_000n;

const addressBytes = (a: Address): Uint8Array => new Uint8Array(getAddressEncoder().encode(a));

function message(): Uint8Array {
  return buildMessage({
    programId: PROGRAM,
    credential: CREDENTIAL,
    schema: SCHEMA,
    wallet: WALLET,
    payload: buildPayload({ issuedAt: ISSUED_AT }),
    expiry: ISSUED_AT + 600n,
  });
}

describe('constants', () => {
  it('pins the FORMATS lengths and tags', () => {
    expect(DOMAIN_TAG).toBe('TIO-ATTEST-v1');
    expect(PAYLOAD_LEN).toBe(83);
    expect(MESSAGE_LEN).toBe(232);
    expect(PRECOMPILE_DATA_LEN).toBe(329);
    expect(SAS_ATTESTATION_LEN).toBe(256);
    expect(SAS_ATTESTATION_DISCRIMINATOR).toBe(2);
    expect(MAX_SIGNATURE_LIFETIME_SECS).toBe(600n);
  });

  it('pins the SAS account offsets', () => {
    expect([
      SAS_NONCE_OFFSET,
      SAS_CREDENTIAL_OFFSET,
      SAS_SCHEMA_OFFSET,
      SAS_DATA_LEN_OFFSET,
      SAS_DATA_OFFSET,
      SAS_SIGNER_OFFSET,
      SAS_EXPIRY_OFFSET,
    ]).toEqual([1, 33, 65, 97, 101, 184, 216]);
  });

  it('uses the secp256k1 precompile program id', () => {
    expect(SECP256K1_PROGRAM).toBe('KeccakSecp256k11111111111111111111111111111');
  });

  it('SAS_PROGRAM_ID equals the ops package value', () => {
    expect(SAS_PROGRAM_ID).toBe(OPS_SAS_PROGRAM_ID);
    expect(SAS_PROGRAM_ID).toBe('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
  });

  it('ORACLE_PROGRAM_ID equals the generated client address', () => {
    expect(ORACLE_PROGRAM_ID).toBe(ORACLE_PROGRAM_ADDRESS);
  });
});

describe('buildMessage (FORMATS §8)', () => {
  it('is 232 bytes', () => {
    expect(message()).toHaveLength(MESSAGE_LEN);
  });

  it('starts with the ASCII domain tag at offset 0', () => {
    expect(new TextDecoder().decode(message().subarray(0, 13))).toBe(DOMAIN_TAG);
  });

  it('places program, credential, schema and wallet at 13, 45, 77, 109', () => {
    const m = message();
    expect(m.subarray(13, 45)).toEqual(addressBytes(PROGRAM));
    expect(m.subarray(45, 77)).toEqual(addressBytes(CREDENTIAL));
    expect(m.subarray(77, 109)).toEqual(addressBytes(SCHEMA));
    expect(m.subarray(109, 141)).toEqual(addressBytes(WALLET));
  });

  it('places the payload at 141 and the little-endian expiry at 224', () => {
    const m = message();
    expect(m.subarray(141, 224)).toEqual(buildPayload({ issuedAt: ISSUED_AT }));
    expect(new DataView(m.buffer, m.byteOffset).getBigInt64(224, true)).toBe(ISSUED_AT + 600n);
  });

  it('rejects a payload that is not 83 bytes', () => {
    for (const length of [0, 82, 84]) {
      expect(() =>
        buildMessage({
          programId: PROGRAM,
          credential: CREDENTIAL,
          schema: SCHEMA,
          wallet: WALLET,
          payload: new Uint8Array(length),
          expiry: 1n,
        }),
      ).toThrow(/payload must be 83 bytes/);
    }
  });
});

describe('payloadIssuedAt', () => {
  it('reads the i64 at offset 67', () => {
    expect(payloadIssuedAt(buildPayload({ issuedAt: ISSUED_AT }))).toBe(ISSUED_AT);
  });

  it('reads correctly from a subarray view with a byte offset', () => {
    const payload = buildPayload({ issuedAt: 42n });
    const padded = new Uint8Array(PAYLOAD_LEN + 5);
    padded.set(payload, 5);
    expect(payloadIssuedAt(padded.subarray(5))).toBe(42n);
  });
});

describe('buildPrecompileData (FORMATS §8 layout)', () => {
  const key = enclaveKey(7);
  const msg = message();
  const signature = signMessage(key.secretKey, msg);
  const build = (index = 1) =>
    buildPrecompileData({ ethAddress: key.ethAddress, signature, message: msg, index });

  it('is 329 bytes', () => {
    expect(build()).toHaveLength(PRECOMPILE_DATA_LEN);
  });

  it('has one signature and the fixed offsets struct', () => {
    const data = build(1);
    const view = new DataView(data.buffer, data.byteOffset);
    expect(data[0]).toBe(1);
    expect(view.getUint16(1, true)).toBe(32);
    expect(data[3]).toBe(1);
    expect(view.getUint16(4, true)).toBe(12);
    expect(data[6]).toBe(1);
    expect(view.getUint16(7, true)).toBe(97);
    expect(view.getUint16(9, true)).toBe(MESSAGE_LEN);
    expect(data[11]).toBe(1);
  });

  it('puts eth address at 12, r‖s‖v at 32 and the message at 97', () => {
    const data = build();
    expect(data.subarray(12, 32)).toEqual(key.ethAddress);
    expect(data.subarray(32, 97)).toEqual(signature);
    expect(data.subarray(97)).toEqual(msg);
  });

  it('sets every instruction-index field to the given index', () => {
    const data = build(5);
    expect([data[3], data[6], data[11]]).toEqual([5, 5, 5]);
  });

  it('equals the oracle-tests builder output for the same key, message and index', () => {
    expect(build(1)).toEqual(testBuildPrecompileData(key, msg, 1));
  });

  it('rejects a wrong-length eth address, signature or message', () => {
    expect(() =>
      buildPrecompileData({ ethAddress: new Uint8Array(19), signature, message: msg, index: 1 }),
    ).toThrow(/eth address must be 20 bytes/);
    expect(() =>
      buildPrecompileData({
        ethAddress: key.ethAddress,
        signature: signature.subarray(0, 64),
        message: msg,
        index: 1,
      }),
    ).toThrow(/signature must be 65 bytes/);
    expect(() =>
      buildPrecompileData({
        ethAddress: key.ethAddress,
        signature,
        message: msg.subarray(1),
        index: 1,
      }),
    ).toThrow(/message must be 232 bytes/);
  });
});

describe('precompileInstruction', () => {
  it('targets the secp256k1 program with no accounts and the data as given', () => {
    const data = new Uint8Array(PRECOMPILE_DATA_LEN).fill(1);
    const ix = precompileInstruction(data);
    expect(ix.programAddress).toBe(SECP256K1_PROGRAM);
    expect(ix.accounts ?? []).toEqual([]);
    expect(ix.data).toEqual(data);
  });
});

describe('attestationAddress', () => {
  it('is deterministic and depends on the wallet', async () => {
    const a = await attestationAddress(CREDENTIAL, SCHEMA, WALLET);
    expect(await attestationAddress(CREDENTIAL, SCHEMA, WALLET)).toBe(a);
    expect(await attestationAddress(CREDENTIAL, SCHEMA, PROGRAM)).not.toBe(a);
  });
});

function sasAccount(
  wallet: Address,
  payload: Uint8Array,
  expiry: bigint,
  signer: Address,
): Uint8Array {
  const data = sasShapedAccount(SAS_ATTESTATION_DISCRIMINATOR);
  data.set(addressBytes(wallet), SAS_NONCE_OFFSET);
  data.set(addressBytes(CREDENTIAL), SAS_CREDENTIAL_OFFSET);
  data.set(addressBytes(SCHEMA), SAS_SCHEMA_OFFSET);
  data.set(payload, SAS_DATA_OFFSET);
  data.set(addressBytes(signer), SAS_SIGNER_OFFSET);
  new DataView(data.buffer).setBigInt64(SAS_EXPIRY_OFFSET, expiry, true);
  return data;
}

describe('parseSasAttestation', () => {
  const payload = buildPayload({ issuedAt: ISSUED_AT, tier: 2 });
  const signer = address('HznYLdoTuhm53WjdvNcQBbGT71n9msXgpJcKiya2Moti');

  it('round-trips a SAS-shaped account', () => {
    const parsed = parseSasAttestation(SAS_PROGRAM_ID, sasAccount(WALLET, payload, 99n, signer));
    expect(parsed).toEqual({
      nonce: WALLET,
      credential: CREDENTIAL,
      schema: SCHEMA,
      signer,
      payload,
      expiry: 99n,
    });
  });

  it('rejects an account not owned by SAS', () => {
    expect(() => parseSasAttestation(PROGRAM, sasAccount(WALLET, payload, 99n, signer))).toThrow(
      /not owned by SAS/,
    );
  });

  it('rejects the wrong length', () => {
    const data = sasAccount(WALLET, payload, 99n, signer);
    expect(() => parseSasAttestation(SAS_PROGRAM_ID, data.subarray(0, 255))).toThrow(
      /attestation account must be 256 bytes/,
    );
    expect(() => parseSasAttestation(SAS_PROGRAM_ID, new Uint8Array(257))).toThrow(
      /attestation account must be 256 bytes/,
    );
  });

  it('rejects the wrong discriminator', () => {
    const data = sasAccount(WALLET, payload, 99n, signer);
    data[0] = 1;
    expect(() => parseSasAttestation(SAS_PROGRAM_ID, data)).toThrow(/not a SAS attestation/);
  });

  it('rejects a data length field other than 83', () => {
    const data = sasAccount(WALLET, payload, 99n, signer);
    new DataView(data.buffer).setUint32(SAS_DATA_LEN_OFFSET, 82, true);
    expect(() => parseSasAttestation(SAS_PROGRAM_ID, data)).toThrow(/data length is not 83/);
  });
});
