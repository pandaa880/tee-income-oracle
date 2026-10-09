import { describe, expect, it } from 'vitest';
import type { StoredAttestation } from '@tio/oracle-client/attest';
import { parseSasAttestation, SAS_PROGRAM_ID } from '@tio/oracle-client/attest';
import { readCredential } from './credential.ts';
import {
  ADMIN,
  entry,
  NOW,
  OTHER,
  payloadBytes,
  pool,
  POLICY_HASH,
  SAS_SIGNER,
  sasAccountBytes,
} from '../test-support/fixtures.ts';

const WALLET = ADMIN;
const MAX_AGE = 2_592_000n;

function attestation(
  payload = payloadBytes(),
  overrides: { expiry?: bigint; signer?: typeof SAS_SIGNER } = {},
): StoredAttestation {
  return parseSasAttestation(
    SAS_PROGRAM_ID,
    sasAccountBytes({ wallet: WALLET, payload, ...overrides }),
  );
}

const base = {
  attestation: attestation(),
  enclaveEntry: entry(),
  pool: pool(),
  sasSigner: SAS_SIGNER,
  now: NOW,
};

const expiringAt = (expiry: bigint): typeof base => ({
  ...base,
  attestation: attestation(payloadBytes(), { expiry }),
});

const aged = (age: bigint): typeof base => ({
  ...base,
  attestation: attestation(payloadBytes({ issuedAt: NOW - age }), { expiry: NOW + 10n }),
});

const everythingWrong = (): typeof base => ({
  ...base,
  attestation: attestation(
    payloadBytes({
      issuedAt: NOW - MAX_AGE - 1n,
      policyHash: new Uint8Array(32).fill(0x99),
      measurementId: 2,
    }),
    { expiry: NOW, signer: OTHER },
  ),
  enclaveEntry: entry({ revokedAt: 1n }),
});

/** A credential whose statement ends at `windowTo` and is exactly the minimum 90 days long. */
const withWindowEnd = (windowTo: number) =>
  readCredential({
    ...base,
    attestation: attestation(payloadBytes({ windowTo, windowFrom: windowTo - 7_776_000 })),
  });

describe('readCredential (the pool checks of FORMATS §14, in the pool order)', () => {
  it('is none without an attestation', () => {
    expect(readCredential({ ...base, attestation: undefined })).toBe('none');
  });

  it('is valid for a fresh attestation from the oracle signer, an approved active enclave', () => {
    expect(readCredential(base)).toBe('valid');
  });

  it('is foreign_signer when the stored signer is not the oracle signer', () => {
    expect(
      readCredential({ ...base, attestation: attestation(payloadBytes(), { signer: OTHER }) }),
    ).toBe('foreign_signer');
  });

  it('is expired when now is exactly the expiry, and valid one second before', () => {
    expect(readCredential(expiringAt(NOW))).toBe('expired');
    expect(readCredential(expiringAt(NOW + 1n))).toBe('valid');
  });

  it('treats an expiry of 0 as expired', () => {
    expect(
      readCredential({ ...base, attestation: attestation(payloadBytes(), { expiry: 0n }) }),
    ).toBe('expired');
  });

  it('is policy_mismatch when the payload policy hash differs from the pool', () => {
    const payload = payloadBytes({ policyHash: new Uint8Array(32).fill(0x99) });
    expect(readCredential({ ...base, attestation: attestation(payload) })).toBe('policy_mismatch');
  });

  it('is stale only when older than max_age_secs: issued_at + max_age exactly is still valid', () => {
    expect(readCredential(aged(MAX_AGE))).toBe('valid');
    expect(readCredential(aged(MAX_AGE + 1n))).toBe('stale');
  });

  it('is not_approved when the pool does not approve the payload measurement id', () => {
    const payload = payloadBytes({ measurementId: 2 });
    expect(readCredential({ ...base, attestation: attestation(payload) })).toBe('not_approved');
  });

  it('honours measurement ids beyond the first byte of the approval bitmap', () => {
    const approved = Uint8Array.from({ length: 32 }, (_, i) => (i === 1 ? 0b10 : 0)); // id 9
    const input = {
      ...base,
      pool: pool({ approvedMeasurements: approved }),
      enclaveEntry: entry({ measurementId: 9 }),
    };
    expect(
      readCredential({ ...input, attestation: attestation(payloadBytes({ measurementId: 9 })) }),
    ).toBe('valid');
    expect(
      readCredential({ ...input, attestation: attestation(payloadBytes({ measurementId: 8 })) }),
    ).toBe('not_approved');
  });

  it('is enclave_revoked when the registry entry has a revoke time', () => {
    expect(readCredential({ ...base, enclaveEntry: entry({ revokedAt: NOW - 5n }) })).toBe(
      'enclave_revoked',
    );
  });

  it('is tier_not_accepted when the pool lends nothing to the payload tier', () => {
    const noTierC = { ...base, pool: pool({ tierLimits: [5_000_000n, 3_000_000n, 0n] }) };
    expect(
      readCredential({ ...noTierC, attestation: attestation(payloadBytes({ tier: 3 })) }),
    ).toBe('tier_not_accepted');
    expect(
      readCredential({ ...noTierC, attestation: attestation(payloadBytes({ tier: 2 })) }),
    ).toBe('valid');
  });

  it('is window_too_old only when issued_at - window_to exceeds max_window_age_secs', () => {
    const maxWindowAge = 31_536_000;
    const issued = Number(NOW - 1000n);
    expect(withWindowEnd(issued - maxWindowAge)).toBe('valid');
    expect(withWindowEnd(issued - maxWindowAge - 1)).toBe('window_too_old');
  });

  it('is window_too_short only when the statement covers less than min_window_secs', () => {
    const windowTo = 1_790_380_800;
    const span = (secs: number) =>
      readCredential({
        ...base,
        attestation: attestation(payloadBytes({ windowTo, windowFrom: windowTo - secs })),
      });
    expect(span(7_776_000)).toBe('valid');
    expect(span(7_775_999)).toBe('window_too_short');
  });

  it('is not_approved when the registry entry is for a different measurement id', () => {
    expect(readCredential({ ...base, enclaveEntry: entry({ measurementId: 1 }) })).toBe(
      'not_approved',
    );
  });

  it('orders the new checks like the program: tier before policy, windows before approval, entry id before revoked', () => {
    const noTierC = pool({ tierLimits: [5_000_000n, 3_000_000n, 0n] });
    const tierCWrongPolicy = payloadBytes({ tier: 3, policyHash: new Uint8Array(32).fill(0x99) });
    expect(
      readCredential({ ...base, pool: noTierC, attestation: attestation(tierCWrongPolicy) }),
    ).toBe('tier_not_accepted');
    const oldWindowUnapproved = payloadBytes({ windowTo: 1, windowFrom: 0, measurementId: 2 });
    expect(readCredential({ ...base, attestation: attestation(oldWindowUnapproved) })).toBe(
      'window_too_old',
    );
    const issued = Number(NOW - 1000n);
    const shortWindowUnapproved = payloadBytes({
      windowTo: issued,
      windowFrom: issued - 10,
      measurementId: 2,
    });
    expect(readCredential({ ...base, attestation: attestation(shortWindowUnapproved) })).toBe(
      'window_too_short',
    );
    const wrongRevokedEntry = entry({ measurementId: 1, revokedAt: 5n });
    expect(readCredential({ ...base, enclaveEntry: wrongRevokedEntry })).toBe('not_approved');
  });

  describe('check order', () => {
    it('reports foreign_signer before everything else', () => {
      expect(readCredential(everythingWrong())).toBe('foreign_signer');
    });

    it('then expired, then policy_mismatch, then stale, then not_approved', () => {
      let stored = everythingWrong().attestation;
      const afterFixing = (patch: Partial<StoredAttestation>) => {
        stored = { ...stored, ...patch };
        return readCredential({ ...everythingWrong(), attestation: stored });
      };
      expect(afterFixing({ signer: SAS_SIGNER })).toBe('expired');
      expect(afterFixing({ expiry: NOW + 1n })).toBe('policy_mismatch');
      const staleButRightPolicy = payloadBytes({
        issuedAt: NOW - MAX_AGE - 1n,
        policyHash: POLICY_HASH,
        measurementId: 2,
      });
      expect(afterFixing({ payload: staleButRightPolicy })).toBe('stale');
      expect(afterFixing({ payload: payloadBytes({ measurementId: 2 }) })).toBe('not_approved');
    });
  });
});
