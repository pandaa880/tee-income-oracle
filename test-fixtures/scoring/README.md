# Scoring hand cases

`hand-cases.json` holds small statements whose expected tier and features were
worked out **by hand** from the FORMATS §6.1 algorithm text. The working is in
each case's `why` field (monthly sums, medians, `D = n*Sxx - Sx^2`, `isqrt`,
FOIR, per-month bounce guard).

**Hand-written, never generated.** Unlike `test-vectors/`, no script writes this
file, and no scorer was run to get the numbers. Do not "fix" an expectation by
copying what `score()` prints: a mismatch means the code or the hand
arithmetic is wrong, and you have to find out which. If §6.1 changes, redo the
arithmetic by hand and update `why` with it.

Two independent implementations replay it, so a shared misreading of the spec
shows up as a failure in at least one of them:

- Rust: `tio-core/tests/scoring_hand.rs`
- TypeScript: `sandbox-bank/src/scoring/hand-cases.test.ts`

## Shape

```
{ "cases": [ {
    "id", "why",
    "policy": "default" | <full v2 policy object>,   // "default" = test-vectors/policy/default.json
    "start": "YYYY-MM-DD", "end": "YYYY-MM-DD",       // the statement's written dates
    "txns": [ { "at": "<RFC 3339 timestamp with zone>", "credit": bool,
                "amount": <int paise>, "balance": <int paise>,
                "bounce": bool, "emi": bool } ],      // bounce/emi = narration word flags
    "expected": { "tier": "A"|"B"|"C"|"REJECT",
                  "full": Features, "recent": Features }
              | { "error": "window_mismatch" }
} ] }
```

`Features` keys: `months`, `income_median_paise`, `obligation_median_paise`,
`foir_bps`, `cv_bps`, `loans`, `bounces`, `unmatched_emi_bounces`, `od_days`.

Notes for readers:

- All statements start on the 1st and end on the last day of a month, so every
  month in them is complete.
- `balance` is only the end-of-transaction balance. It is **not** kept
  consistent with the amounts (most cases use a constant large positive value);
  only the `od_*` case relies on it.
- Times use `+05:30` so the India calendar day is the written date; the
  `india_day_*` cases deliberately sit on the day boundaries.
- The `decline_*` case uses a custom policy (tier A `cv_max_bps` 3000) because
  the default A limit (1500) can never be met with 5 of 17 months at -50%.
