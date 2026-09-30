import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { policyBytes, policyHashHex } from './policy.ts';

// FORMATS §6 example, canonicalized by hand (JCS: keys sorted, no
// whitespace) so the test doesn't depend on our own canonicalize().
const EXPECTED_CANONICAL_JSON =
  '{"recent_months":3,"recurrence":{"amount_tol_bps":1000,"day_tol":5,"min_occurrences":3},' +
  '"reject_if":{"od_days_min":30},' +
  '"tiers":[{"bounces_max":0,"cv_max_bps":1500,"foir_max_bps":4000,"tier":"A"},' +
  '{"bounces_max":1,"cv_max_bps":5000,"foir_max_bps":5500,"tier":"B"},' +
  '{"bounces_max":3,"cv_max_bps":6000,"foir_max_bps":7000,"tier":"C"}],' +
  '"v":2,"window":{"max_age_days":7,"min_days":180}}';

describe('policyBytes', () => {
  it('equals the canonical JCS bytes of the FORMATS §6 example', () => {
    expect(new TextDecoder().decode(policyBytes())).toBe(EXPECTED_CANONICAL_JSON);
  });
});

describe('policyHashHex', () => {
  it('is the sha256 hex digest of policyBytes()', () => {
    const expected = createHash('sha256').update(policyBytes()).digest('hex');
    expect(policyHashHex()).toBe(expected);
  });

  it('is a 64-character lowercase hex string', () => {
    expect(policyHashHex()).toMatch(/^[0-9a-f]{64}$/);
  });
});
