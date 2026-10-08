import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Rpc, type SolanaRpcApi, address, generateKeyPairSigner } from '@solana/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPECTED_TIERS, outcomeOf, runE2e } from './e2e-devnet.ts';

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
