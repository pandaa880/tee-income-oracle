import { describe, expect, it } from 'vitest';
import { b64Encode, derToSingleLinePem, utf8 } from '../crypto/encoding.ts';
import { buildConsent } from './consent.ts';
import { buildFetchResponse, buildFipEnvelope } from './fetch-response.ts';
import { buildFiRequest } from './fi-request.ts';
import { buildKeyMaterial, isoUtc } from './key-material.ts';

// Fixed values (api.md): now = 1790416800 (2026-09-26T10:00:00.000Z),
// KeyMaterial expiry = now + 86400.
const NOW_UNIX = 1_790_416_800;
const EXPIRY_UNIX = NOW_UNIX + 86_400;

describe('isoUtc', () => {
  it('formats the fixed "now" instant', () => {
    expect(isoUtc(NOW_UNIX)).toBe('2026-09-26T10:00:00.000Z');
  });

  it('formats the fixed KeyMaterial expiry (now + 24h)', () => {
    expect(isoUtc(EXPIRY_UNIX)).toBe('2026-09-27T10:00:00.000Z');
  });
});

describe('buildKeyMaterial', () => {
  it('builds the exact FORMATS §3 shape with a single-line PEM', () => {
    const spki = new Uint8Array([1, 2, 3, 4, 5]);
    const nonce = new Uint8Array(32).fill(7);

    const keyMaterial = buildKeyMaterial(spki, nonce, EXPIRY_UNIX);

    expect(keyMaterial).toEqual({
      cryptoAlg: 'ECDH',
      curve: 'Curve25519',
      params: '',
      DHPublicKey: {
        expiry: '2026-09-27T10:00:00.000Z',
        Parameters: '',
        KeyValue: derToSingleLinePem(spki),
      },
      Nonce: b64Encode(nonce),
    });
  });

  it('emits a single-line PEM (no embedded newlines) for KeyValue', () => {
    const keyMaterial = buildKeyMaterial(
      new Uint8Array([9, 9, 9]),
      new Uint8Array(32),
      EXPIRY_UNIX,
    );
    expect(keyMaterial.DHPublicKey.KeyValue.includes('\n')).toBe(false);
    expect(keyMaterial.DHPublicKey.KeyValue.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    expect(keyMaterial.DHPublicKey.KeyValue.endsWith('-----END PUBLIC KEY-----')).toBe(true);
  });
});

describe('buildFiRequest', () => {
  it('builds the FORMATS §5.1 shape', () => {
    const keyMaterial = buildKeyMaterial(new Uint8Array([1]), new Uint8Array(32), EXPIRY_UNIX);
    const request = buildFiRequest({
      txnid: 'txn-uuid',
      timestamp: isoUtc(NOW_UNIX),
      consentId: 'consent-uuid',
      consentSignature: 'sig-segment',
      from: '2026-03-26T00:00:00.000Z',
      to: '2026-09-26T00:00:00.000Z',
      keyMaterial,
    }) as Record<string, unknown>;

    expect(request['ver']).toBe('1.1.3');
    expect(request['timestamp']).toBe(isoUtc(NOW_UNIX));
    expect(request['txnid']).toBe('txn-uuid');
    expect(request['Consent']).toEqual({ id: 'consent-uuid', digitalSignature: 'sig-segment' });
    expect(request['FIDataRange']).toEqual({
      from: '2026-03-26T00:00:00.000Z',
      to: '2026-09-26T00:00:00.000Z',
    });
    expect(request['KeyMaterial']).toEqual(keyMaterial);
  });
});

describe('buildFetchResponse', () => {
  it('puts KeyMaterial on the FI[] entry, not inside data[]', () => {
    const keyMaterial = buildKeyMaterial(new Uint8Array([1]), new Uint8Array(32), EXPIRY_UNIX);
    const response = buildFetchResponse({
      txnid: 'txn-uuid',
      timestamp: isoUtc(NOW_UNIX),
      linkRefNumber: 'link-ref',
      maskedAccNumber: 'XXXXXX1234',
      encryptedFi: 'ciphertext-b64',
      keyMaterial,
    }) as {
      ver: string;
      FI: ReadonlyArray<{
        fipID: string;
        KeyMaterial: unknown;
        data: ReadonlyArray<Record<string, unknown>>;
      }>;
    };

    expect(response.ver).toBe('1.1.3');
    expect(response.FI).toHaveLength(1);
    const fiEntry = response.FI[0];
    if (fiEntry === undefined) {
      throw new Error('expected FI[0]');
    }
    expect(fiEntry.fipID).toBe('SANDBOX-FIP');
    expect(fiEntry.KeyMaterial).toEqual(keyMaterial);
    expect(fiEntry.data).toHaveLength(1);
    const dataEntry = fiEntry.data[0];
    if (dataEntry === undefined) {
      throw new Error('expected data[0]');
    }
    expect(dataEntry['linkRefNumber']).toBe('link-ref');
    expect(dataEntry['maskedAccNumber']).toBe('XXXXXX1234');
    expect(dataEntry['encryptedFI']).toBe('ciphertext-b64');
    // KeyMaterial belongs on the FI[] entry only, per Finvu's sample
    // (FORMATS §5.2): one FIP key serves every account in data[].
    expect('KeyMaterial' in dataEntry).toBe(false);
  });
});

describe('buildFipEnvelope', () => {
  it('base64-encodes the FI bytes and carries the FIP JWS verbatim', () => {
    const fiBytes = utf8('{"type":"DEPOSIT"}');
    const envelope = buildFipEnvelope(fiBytes, 'header..signature');

    expect(envelope).toEqual({ fi: b64Encode(fiBytes), jws: 'header..signature' });
  });
});

describe('buildConsent', () => {
  it('builds the FORMATS §5.3 payload subset', () => {
    const consent = buildConsent({
      consentId: 'consent-uuid',
      status: 'ACTIVE',
      start: '2026-09-25T10:00:00.000Z',
      expiry: '2027-09-26T10:00:00.000Z',
      from: '2026-03-26T00:00:00.000Z',
      to: '2026-09-26T00:00:00.000Z',
    }) as Record<string, unknown>;

    expect(consent['consentId']).toBe('consent-uuid');
    expect(consent['status']).toBe('ACTIVE');
    expect(consent['consentStart']).toBe('2026-09-25T10:00:00.000Z');
    expect(consent['consentExpiry']).toBe('2027-09-26T10:00:00.000Z');
    expect(consent['consentMode']).toBe('VIEW');
    expect(consent['fetchType']).toBe('ONETIME');
    expect(consent['consentTypes']).toEqual(['TRANSACTIONS']);
    expect(consent['fiTypes']).toEqual(['DEPOSIT']);
    expect(consent['FIDataRange']).toEqual({
      from: '2026-03-26T00:00:00.000Z',
      to: '2026-09-26T00:00:00.000Z',
    });
    expect(consent['DataLife']).toEqual({ unit: 'DAY', value: 0 });
  });

  it('reflects a non-ACTIVE status verbatim (used to build the consent_not_active negative case)', () => {
    const consent = buildConsent({
      consentId: 'consent-uuid',
      status: 'REVOKED',
      start: '2026-09-25T10:00:00.000Z',
      expiry: '2027-09-26T10:00:00.000Z',
      from: '2026-03-26T00:00:00.000Z',
      to: '2026-09-26T00:00:00.000Z',
    }) as Record<string, unknown>;

    expect(consent['status']).toBe('REVOKED');
  });
});
