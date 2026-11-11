// What the product does today and what is still to come. Each capability has exactly one stage,
// and every landing section looks it up here, so the page can't call the same thing NEXT in one
// place and PLANNED in another. The stages are claims about the product: they live here, tested.
import type { Tone } from '@tio/ui/tokens';

export type RoadmapStage = 'complete' | 'live' | 'next' | 'planned' | 'needs_partner';

export type Capability =
  /** A receipt from the borrower's bank data, under the pool's eligibility criteria. */
  | 'bank_receipt'
  /** Bank data read only inside the attested enclave, then wiped. */
  | 'enclave_check'
  /** Receipts written to Solana and read by the demo pools. */
  | 'receipts_on_chain'
  /** Open-source code and a reproducible enclave build. */
  | 'open_source_build'
  /** The public verify page and the funder's loan book. */
  | 'verify_and_book'
  /** Receipts keyed to the NBFC's loan ID, so a funder can match the whole pool. */
  | 'loan_id_receipts'
  /** A later bank pull shows the loan amount arriving. */
  | 'payout_proof'
  /** Monthly bank pulls show the EMIs leaving. */
  | 'repayment_check'
  /** Mismatches between the NBFC's report and the bank flagged to the funder. */
  | 'mismatch_flags'
  /** Funder rules that act on the checks (stop drawdowns, trap cash). */
  | 'pool_rules'
  /** Real bank data, which needs an NBFC partner registered as the AA user. */
  | 'real_bank_data';

const CAPABILITY_STAGE: Record<Capability, RoadmapStage> = {
  bank_receipt: 'live',
  enclave_check: 'complete',
  receipts_on_chain: 'complete',
  open_source_build: 'complete',
  verify_and_book: 'complete',
  loan_id_receipts: 'next',
  payout_proof: 'next',
  repayment_check: 'planned',
  mismatch_flags: 'planned',
  pool_rules: 'planned',
  real_bank_data: 'needs_partner',
};

const STAGE_LABEL: Record<RoadmapStage, string> = {
  complete: 'COMPLETE',
  live: 'LIVE ON DEVNET',
  next: 'NEXT',
  planned: 'PLANNED',
  needs_partner: 'NEEDS A PARTNER',
};

const STAGE_TONE: Record<RoadmapStage, Tone> = {
  complete: 'positive',
  live: 'positive',
  next: 'caution',
  planned: 'neutral',
  needs_partner: 'neutral',
};

export function stageOf(capability: Capability): RoadmapStage {
  return CAPABILITY_STAGE[capability];
}

export function stageLabel(stage: RoadmapStage): string {
  return STAGE_LABEL[stage];
}

export function stageTone(stage: RoadmapStage): Tone {
  return STAGE_TONE[stage];
}

/** Built and running today (on devnet), as opposed to next, planned or waiting on a partner. */
export function isBuilt(stage: RoadmapStage): boolean {
  return stage === 'complete' || stage === 'live';
}
