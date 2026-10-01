/** Default scoring policy (FORMATS §6). Threshold values are still OPEN. */

import { createHash } from 'node:crypto';

import { utf8 } from '../crypto/encoding.ts';
import { canonicalize, type JsonValue } from '../crypto/jcs.ts';

export const DEFAULT_POLICY = {
  v: 2,
  recurrence: { amount_tol_bps: 1000, day_tol: 5, min_occurrences: 3 },
  recent_months: 3,
  window: { min_days: 180, max_age_days: 7 },
  tiers: [
    { tier: 'A', foir_max_bps: 4000, cv_max_bps: 1500, bounces_max: 0 },
    { tier: 'B', foir_max_bps: 5500, cv_max_bps: 5000, bounces_max: 1 },
    { tier: 'C', foir_max_bps: 7000, cv_max_bps: 6000, bounces_max: 3 },
  ],
  reject_if: { od_days_min: 30 },
} as const satisfies JsonValue;

/** JCS bytes: the exact bytes that `policy_hash` commits to. */
export function policyBytes(): Uint8Array {
  return utf8(canonicalize(DEFAULT_POLICY));
}

/** `policy_hash = sha256(JCS(policy))`, lowercase hex. */
export function policyHashHex(): string {
  return createHash('sha256').update(policyBytes()).digest('hex');
}
