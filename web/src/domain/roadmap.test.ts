import { describe, expect, it } from 'vitest';
import {
  type Capability,
  type RoadmapStage,
  isBuilt,
  stageLabel,
  stageOf,
  stageTone,
} from './roadmap.ts';

const EXPECTED: [Capability, RoadmapStage][] = [
  ['bank_receipt', 'live'],
  ['enclave_check', 'complete'],
  ['receipts_on_chain', 'complete'],
  ['open_source_build', 'complete'],
  ['verify_and_book', 'complete'],
  ['loan_id_receipts', 'next'],
  ['payout_proof', 'next'],
  ['repayment_check', 'planned'],
  ['mismatch_flags', 'planned'],
  ['pool_rules', 'planned'],
  ['real_bank_data', 'needs_partner'],
];

describe('roadmap', () => {
  it.each(EXPECTED)('puts %s at stage %s', (capability, stage) => {
    expect(stageOf(capability)).toBe(stage);
  });

  it('never calls payout, repayment, mismatch flags or pool rules built', () => {
    const unbuilt: Capability[] = [
      'payout_proof',
      'repayment_check',
      'mismatch_flags',
      'pool_rules',
    ];
    for (const capability of unbuilt) expect(isBuilt(stageOf(capability))).toBe(false);
  });

  it('labels and tones each stage, positive only for built work', () => {
    const table: [RoadmapStage, string, string, boolean][] = [
      ['complete', 'COMPLETE', 'positive', true],
      ['live', 'LIVE ON DEVNET', 'positive', true],
      ['next', 'NEXT', 'caution', false],
      ['planned', 'PLANNED', 'neutral', false],
      ['needs_partner', 'NEEDS A PARTNER', 'neutral', false],
    ];
    for (const [stage, label, tone, built] of table) {
      expect(stageLabel(stage)).toBe(label);
      expect(stageTone(stage)).toBe(tone);
      expect(isBuilt(stage)).toBe(built);
    }
  });
});
