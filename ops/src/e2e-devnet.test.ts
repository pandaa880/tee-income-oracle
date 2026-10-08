import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Rpc, type SolanaRpcApi, address, generateKeyPairSigner } from '@solana/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BORROW_AMOUNT,
  EXPECTED_TIERS,
  checkStoredAttestation,
  outcomeOf,
  runE2e,
  tierOfPayload,
} from './e2e-devnet.ts';
import { POOL_DEFAULTS } from './pool-setup.ts';

const MANIFEST_PATH = fileURLToPath(new URL('../../test-vectors/manifest.json', import.meta.url));

type ManifestCase = { id: string; kind: string; persona_id: string; expected?: { tier?: string } };

function manifestCases(): ManifestCase[] {
  const manifest: unknown = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('cases' in manifest)) {
    throw new Error('manifest has no cases');
  }
  return manifest.cases as ManifestCase[];
}

describe('EXPECTED_TIERS', () => {
  it('maps_the_four_personas', () => {
    expect(EXPECTED_TIERS).toEqual({
      salaried_steady: 'A',
      trader_lumpy: 'B',
      declining: 'C',
      stressed: 'REJECT',
    });
  });

  it('equals_the_tier_of_each_persona_vector_in_the_manifest', () => {
    const fromManifest: Record<string, string | undefined> = {};
    for (const c of manifestCases()) {
      if (c.kind === 'positive' && c.id === c.persona_id) fromManifest[c.id] = c.expected?.tier;
    }
    expect(EXPECTED_TIERS).toEqual(fromManifest);
  });
});

const stage = (name: string) => ({ event: 'stage', data: { stage: name } });

describe('outcomeOf', () => {
  it('reads_the_result_event_of_a_lent_tier', () => {
    const outcome = outcomeOf([
      stage('bind'),
      stage('submit'),
      {
        event: 'result',
        data: {
          tier: 'A',
          tx: 'sig1',
          attestation: 'Att111',
          expiry: 1_790_000_000,
          payload_hex: '0a0b',
        },
      },
    ]);
    expect(outcome).toEqual({
      ok: true,
      tier: 'A',
      tx: 'sig1',
      attestation: 'Att111',
      payloadHex: '0a0b',
    });
  });

  it('keeps_tx_null_when_the_payload_was_already_on_chain', () => {
    const outcome = outcomeOf([
      {
        event: 'result',
        data: { tier: 'B', tx: null, attestation: 'Att', expiry: 1, payload_hex: 'ff' },
      },
    ]);
    expect(outcome).toMatchObject({ ok: true, tier: 'B', tx: null });
  });

  it('reads_a_reject_result_without_attestation_fields', () => {
    const outcome = outcomeOf([stage('evaluate'), { event: 'result', data: { tier: 'REJECT' } }]);
    expect(outcome).toMatchObject({ ok: true, tier: 'REJECT' });
    expect(outcome).not.toHaveProperty('payloadHex');
  });

  it('uses_the_last_result_when_there_are_several', () => {
    const outcome = outcomeOf([
      { event: 'result', data: { tier: 'C' } },
      { event: 'result', data: { tier: 'A', tx: null, attestation: 'x', payload_hex: '00' } },
    ]);
    expect(outcome).toMatchObject({ ok: true, tier: 'A' });
  });

  it('turns_an_error_event_into_a_failure_with_its_stage_and_code', () => {
    const outcome = outcomeOf([
      stage('bind'),
      { event: 'error', data: { code: 'enclave_down', message: 'x', stage: 'evaluate' } },
    ]);
    expect(outcome).toEqual({ ok: false, stage: 'evaluate', code: 'enclave_down' });
  });

  it('fails_with_stream_no_result_when_the_stream_ends_with_only_stages', () => {
    expect(outcomeOf([stage('bind'), stage('fi_request')])).toEqual({
      ok: false,
      stage: 'stream',
      code: 'no_result',
    });
  });

  it('fails_with_stream_no_result_for_an_empty_stream', () => {
    expect(outcomeOf([])).toEqual({ ok: false, stage: 'stream', code: 'no_result' });
  });
});

describe('runE2e', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses_an_rpc_that_is_not_the_named_cluster_before_any_request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rpc = {
      getGenesisHash: () => ({ send: async () => 'NotDevnetGenesisHash1111111111111111111111111' }),
    } as unknown as Rpc<SolanaRpcApi>;
    const any = address('11111111111111111111111111111111');
    const run = runE2e({
      cluster: 'devnet',
      rpc,
      rpcSubscriptions: {} as never,
      gatewayUrl: 'http://127.0.0.1:1',
      admin: await generateKeyPairSigner(),
      credential: any,
      schema: any,
      pool: any,
      mint: any,
      log: () => {},
    });
    await expect(run).rejects.toMatchObject({ code: 'cluster_mismatch' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/** An 83-byte §7 payload with `tier` in byte 0 and filler elsewhere. */
function payloadWithTier(tier: number): Uint8Array {
  const payload = new Uint8Array(83).fill(7);
  payload[0] = tier;
  return payload;
}
const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('tierOfPayload', () => {
  it.each([
    [1, 'A'],
    [2, 'B'],
    [3, 'C'],
  ])('reads_tier_byte_%i_as_%s', (byte, tier) => {
    expect(tierOfPayload(payloadWithTier(byte))).toBe(tier);
  });

  it.each([0, 4, 255])('returns_undefined_for_tier_byte_%i', (byte) => {
    expect(tierOfPayload(payloadWithTier(byte))).toBeUndefined();
  });
});

describe('checkStoredAttestation', () => {
  it('passes_when_the_stored_payload_is_the_reported_one_and_encodes_the_expected_tier', () => {
    const stored = payloadWithTier(1);
    expect(checkStoredAttestation('A', stored, hexOf(stored))).toBe(true);
  });

  it('fails_when_the_stored_tier_differs_from_the_expected_one_even_if_the_bytes_match', () => {
    // The reproduction from review: gateway reports A, the chain holds a tier C payload.
    const stored = payloadWithTier(3);
    expect(checkStoredAttestation('A', stored, hexOf(stored))).toBe(false);
  });

  it('fails_when_the_stored_bytes_differ_from_the_reported_payload', () => {
    expect(checkStoredAttestation('A', payloadWithTier(1), hexOf(payloadWithTier(2)))).toBe(false);
  });

  it('fails_when_a_lent_tier_has_no_attestation_on_chain', () => {
    expect(checkStoredAttestation('B', undefined, hexOf(payloadWithTier(2)))).toBe(false);
  });

  it('passes_a_reject_only_when_nothing_is_stored', () => {
    expect(checkStoredAttestation('REJECT', undefined, undefined)).toBe(true);
    expect(checkStoredAttestation('REJECT', payloadWithTier(3), undefined)).toBe(false);
  });
});

describe('BORROW_AMOUNT', () => {
  it('only_a_tier_a_attestation_can_borrow_it_from_the_demo_pool', () => {
    const [limitA, limitB] = POOL_DEFAULTS.tierLimits;
    expect(BORROW_AMOUNT > limitB).toBe(true);
    expect(BORROW_AMOUNT <= limitA).toBe(true);
  });
});
