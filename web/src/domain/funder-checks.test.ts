import { describe, expect, it } from 'vitest';
import { FUNDER_CHECKS, checkStatusLabel, checkStatusTone } from './funder-checks.ts';

describe('FUNDER_CHECKS', () => {
  it('claims as checkable now only what the chain and the attestation show today', () => {
    expect(FUNDER_CHECKS.map((c) => c.status)).toEqual(['now', 'now', 'now', 'not_yet', 'next']);
  });

  it('never presents repayment as something a tier shows', () => {
    const now = FUNDER_CHECKS.filter((c) => c.status === 'now');
    for (const check of now) expect(`${check.claim} ${check.evidence}`).not.toMatch(/repa(y|id)/i);
  });

  it('describes checks without asserting a live result (registration comes from the registry read)', () => {
    for (const check of FUNDER_CHECKS) expect(check.evidence).not.toMatch(/\bregistered\b/i);
  });

  it('gives every check a claim and its evidence', () => {
    for (const check of FUNDER_CHECKS) {
      expect(check.claim.length).toBeGreaterThan(0);
      expect(check.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe('check status words and tones', () => {
  it.each([
    ['now', 'CHECKABLE NOW', 'positive'],
    ['not_yet', 'NOT YET', 'neutral'],
    ['next', 'NEXT', 'info'],
  ] as const)('%s reads %s in the %s tone', (status, label, tone) => {
    expect(checkStatusLabel(status)).toBe(label);
    expect(checkStatusTone(status)).toBe(tone);
  });
});
