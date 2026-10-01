//! Boundary tests for `tio_core::evaluate` on the committed `salaried_steady`
//! vector, changing only the enclave-side inputs (`Session`, `Clock`): the
//! signed artefacts are never touched, so nothing is re-signed.
//!
//! The vector (`docs/FORMATS.md` §11, clock fixed by the generator):
//!
//! | Quantity            | Value                                  |
//! |---------------------|----------------------------------------|
//! | `now`               | 2026-09-26T10:00Z                      |
//! | `consentStart`      | 2026-09-25T10:00Z (`now` − 1 day)      |
//! | `consentExpiry`     | 2027-09-26T10:00Z (`now` + 365 days)   |
//! | range = consent range | 2025-09-26T00:00Z .. 2026-09-26T00:00Z |
//! | policy              | `min_days` 180, `max_age_days` 7       |
//!
//! Changing `now` moves BOTH the consent time checks (7) and the staleness
//! check (10). Each test therefore picks `now` so exactly one check can fire,
//! and says why in a comment. Check order is the plan's (consent time before
//! window, window before staleness), so a later check can never mask an
//! earlier one but an earlier one can mask a later one.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use tio_core::{Clock, ErrorCode, FiDataRange, Outcome, Policy};

use common::{load_json, test_vectors_dir, CaseFixture, Overrides};

const DAY: i64 = 86_400;

fn fixture(case: &str) -> CaseFixture {
    CaseFixture::load(&test_vectors_dir().join("vectors").join(case))
}

fn salaried() -> CaseFixture {
    fixture("salaried_steady")
}

fn at(fx: &CaseFixture, now: i64) -> Overrides {
    Overrides {
        clock: Some(Clock {
            now,
            expiry: fx.clock.expiry,
        }),
        ..Overrides::default()
    }
}

fn code(fx: &CaseFixture, overrides: &Overrides) -> Result<(), &'static str> {
    fx.evaluate_with(overrides)
        .map(|_| ())
        .map_err(|e| e.code())
}

fn with_range(from: i64, to: i64) -> Overrides {
    Overrides {
        range: Some(FiDataRange::new(from, to).unwrap()),
        ..Overrides::default()
    }
}

// --- sanity: the vector is what this file's comments say it is -----------

#[test]
fn salaried_steady_vector_has_the_documented_times() {
    let fx = salaried();
    let (start, expiry) = fx.consent_times();
    assert_eq!(fx.clock.now, 1_790_416_800, "2026-09-26T10:00Z");
    assert_eq!(start, fx.clock.now - DAY);
    assert_eq!(expiry, fx.clock.now + 365 * DAY);
    assert_eq!(fx.range.to() - fx.range.from(), 365 * DAY);
    assert_eq!(fx.range.to() % DAY, 0, "range ends on a UTC day boundary");
}

#[test]
fn the_unmodified_vector_evaluates_ok() {
    let fx = salaried();
    assert!(fx.evaluate().is_ok());
}

// --- consent time: consentStart <= now < consentExpiry --------------------

// now = consentExpiry. Consent check (7) comes before staleness (10), so the
// stale condition (now is a year past `to`) cannot hide the result: the code
// is consent_invalid, not window_stale.
#[test]
fn now_equal_to_consent_expiry_is_consent_invalid() {
    let fx = salaried();
    let (_, expiry) = fx.consent_times();
    assert_eq!(code(&fx, &at(&fx, expiry)), Err("consent_invalid"));
}

// now = consentExpiry - 1 passes the consent time check. It cannot be Ok
// through Session/Clock alone: the consent range ends 2026-09-26 and `now` is
// a year later, so the request is legitimately stale. The proof that the
// consent check passed is that the failure is window_stale, not
// consent_invalid (the next check in order fired, not this one).
#[test]
fn now_one_second_before_consent_expiry_passes_the_consent_check() {
    let fx = salaried();
    let (_, expiry) = fx.consent_times();
    assert_eq!(code(&fx, &at(&fx, expiry - 1)), Err("window_stale"));
}

// now = consentStart. Check 7 passes (a consent-time failure would be
// consent_invalid), and the window then ends in the future: to =
// 2026-09-26T00:00 is after start = 2026-09-25T10:00, so check 10 rejects it
// as window_mismatch. The consent boundary itself is therefore only
// observable through the failure code of the next check.
#[test]
fn now_equal_to_consent_start_passes_the_consent_check_then_fails_future_window() {
    let fx = salaried();
    let (start, _) = fx.consent_times();
    assert_eq!(code(&fx, &at(&fx, start)), Err("window_mismatch"));
}

#[test]
fn now_one_second_before_consent_start_is_consent_invalid() {
    let fx = salaried();
    let (start, _) = fx.consent_times();
    assert_eq!(code(&fx, &at(&fx, start - 1)), Err("consent_invalid"));
}

// --- staleness: now - to > max_age_days * 86400 ----------------------------

// now = to + 7 days exactly: within consent (consentExpiry is a year out) and
// not stale because the rule is strictly greater-than.
#[test]
fn staleness_exactly_at_max_age_is_ok() {
    let fx = salaried();
    let now = fx.range.to() + 7 * DAY;
    assert!(fx.evaluate_with(&at(&fx, now)).is_ok());
}

#[test]
fn staleness_one_second_past_max_age_is_window_stale() {
    let fx = salaried();
    let now = fx.range.to() + 7 * DAY + 1;
    assert_eq!(code(&fx, &at(&fx, now)), Err("window_stale"));
}

// --- future window end: to > now ---------------------------------------------

// now = to exactly: the window ends at the moment it is evaluated, which is
// allowed. The consent window (start 2026-09-25T10:00 <= to) and staleness
// (age 0) are fine.
#[test]
fn now_equal_to_window_end_is_ok() {
    let fx = salaried();
    assert!(fx.evaluate_with(&at(&fx, fx.range.to())).is_ok());
}

#[test]
fn now_one_second_before_window_end_is_window_mismatch() {
    let fx = salaried();
    assert_eq!(
        code(&fx, &at(&fx, fx.range.to() - 1)),
        Err("window_mismatch")
    );
}

// --- statement vs window ----------------------------------------------------

// The statement ends on 2026-09-26; a window ending a day earlier leaves its
// last day outside (check 15, end-day half).
#[test]
fn window_ending_a_day_before_the_statement_end_is_window_mismatch() {
    let fx = salaried();
    let overrides = with_range(fx.range.from(), fx.range.to() - DAY);
    assert_eq!(code(&fx, &overrides), Err("window_mismatch"));
}

// --- flooring ------------------------------------------------------------------

// An unaligned start is floored to its UTC day in the payload.
#[test]
fn unaligned_window_start_is_floored_in_the_evaluation() {
    let fx = salaried();
    let overrides = with_range(fx.range.from() + 3600, fx.range.to());
    let evaluation = fx.evaluate_with(&overrides).unwrap();
    assert_eq!(i64::from(evaluation.window_from), fx.range.from());
    assert_eq!(i64::from(evaluation.window_to), fx.range.to());
}

// --- session binding ------------------------------------------------------

#[test]
fn wrong_txnid_is_session_mismatch() {
    let fx = salaried();
    let overrides = Overrides {
        txnid: Some("00000000-0000-4000-8000-000000000000".to_owned()),
        ..Overrides::default()
    };
    assert_eq!(code(&fx, &overrides), Err("session_mismatch"));
}

#[test]
fn txnid_differing_only_in_case_is_session_mismatch() {
    let fx = salaried();
    let overrides = Overrides {
        txnid: Some(fx.txnid.to_uppercase()),
        ..Overrides::default()
    };
    assert_eq!(code(&fx, &overrides), Err("session_mismatch"));
}

#[test]
fn wrong_consent_id_is_session_mismatch() {
    let fx = salaried();
    let overrides = Overrides {
        consent_id: Some("00000000-0000-4000-8000-000000000000".to_owned()),
        ..Overrides::default()
    };
    assert_eq!(code(&fx, &overrides), Err("session_mismatch"));
}

// --- requested range must lie inside the consent range -----------------------

// The vector's requested range equals the consent range (both ends), so one
// second more on either side is outside it. Check 8 runs before the
// window-length (9) and staleness (10) checks, so only window_mismatch can fire.
#[test]
fn requested_range_one_second_before_consent_from_is_window_mismatch() {
    let fx = salaried();
    let overrides = with_range(fx.range.from() - 1, fx.range.to());
    assert_eq!(code(&fx, &overrides), Err("window_mismatch"));
}

#[test]
fn requested_range_one_second_after_consent_to_is_window_mismatch() {
    let fx = salaried();
    let overrides = with_range(fx.range.from(), fx.range.to() + 1);
    assert_eq!(code(&fx, &overrides), Err("window_mismatch"));
}

// --- policy window length: to - from < min_days * 86400 ----------------------

// Requested range 179 days, inside the consent range, ending at the same
// `to` (so not stale): only window_too_short can fire.
#[test]
fn requested_range_of_179_days_is_window_too_short() {
    let fx = salaried();
    let to = fx.range.to();
    let overrides = with_range(to - 179 * DAY, to);
    assert_eq!(code(&fx, &overrides), Err("window_too_short"));
}

// Exactly 180 days passes the length check (strict <). The statement still
// spans the whole year, so it then sticks out of the 180-day request: the
// failure is window_mismatch from the later statement check (15), which
// proves check 9 let 180 days through.
#[test]
fn requested_range_of_exactly_180_days_passes_the_length_check() {
    let fx = salaried();
    let to = fx.range.to();
    let overrides = with_range(to - 180 * DAY, to);
    assert_eq!(code(&fx, &overrides), Err("window_mismatch"));
}

// --- what the attestation carries ----------------------------------------------

// Overriding `now` must show up as issued_at (payload offset 67, i64 LE) so
// the clock is used, not read from anywhere else.
#[test]
fn issued_at_in_the_payload_is_the_clock_now() {
    let fx = salaried();
    // now = one hour past the window end: not before the end (that would be
    // window_mismatch), differs from the vector's, and differs from the
    // payload's window_to, so a payload that used window_to is caught.
    let now = fx.range.to() + 3600;
    assert_ne!(now, fx.clock.now);
    let evaluation = fx.evaluate_with(&at(&fx, now)).unwrap();
    assert_ne!(now, i64::from(evaluation.window_to));
    let attestation = evaluation.attestation.unwrap();
    assert_eq!(&attestation.payload[67..75], &now.to_le_bytes());
}

#[test]
fn message_expiry_is_the_clock_expiry() {
    let fx = salaried();
    let overrides = Overrides {
        clock: Some(Clock {
            now: fx.clock.now,
            expiry: fx.clock.now + 1234,
        }),
        ..Overrides::default()
    };
    let attestation = fx.evaluate_with(&overrides).unwrap().attestation.unwrap();
    assert_eq!(
        &attestation.message[224..232],
        &(fx.clock.now + 1234).to_le_bytes()
    );
}

#[test]
fn message_carries_the_session_wallet() {
    let fx = salaried();
    let attestation = fx.evaluate().unwrap().attestation.unwrap();
    assert_eq!(&attestation.message[109..141], &fx.wallet);
}

#[test]
fn tier_a_attestation_payload_starts_with_tier_and_proof_type_bytes() {
    let fx = salaried();
    let evaluation = fx.evaluate().unwrap();
    let attestation = evaluation.attestation.unwrap();
    assert_eq!(attestation.payload[0], 1, "tier A");
    assert_eq!(attestation.payload[1], 1, "tee_nitro_oyster");
}

// --- REJECT ---------------------------------------------------------------------

#[test]
fn stressed_vector_is_rejected_without_an_attestation() {
    let fx = fixture("stressed");
    let evaluation = fx.evaluate().unwrap();
    assert_eq!(evaluation.outcome, Outcome::Reject);
    assert_eq!(evaluation.attestation, None);
}

#[test]
fn stressed_vector_still_reports_window_and_hashes() {
    let fx = fixture("stressed");
    let evaluation = fx.evaluate().unwrap();
    assert_eq!(i64::from(evaluation.window_from), fx.range.from());
    assert_eq!(i64::from(evaluation.window_to), fx.range.to());
    let expected = load_json(
        &test_vectors_dir()
            .join("vectors")
            .join("stressed")
            .join("expected.json"),
    );
    assert_eq!(
        hex::encode(evaluation.policy_hash.as_bytes()),
        expected["policy_hash"].as_str().unwrap()
    );
    assert_eq!(
        hex::encode(evaluation.consent_hash),
        expected["consent_hash"].as_str().unwrap()
    );
}

// --- check 15b: the statement spans at least min_days ---------------------------

// The stressed vector's statement is 2026-03-26..2026-09-26: 185 days
// inclusive, under a 365-day request. Only `min_days` is varied.
fn stressed_with_min_days(min_days: u64) -> CaseFixture {
    let mut fx = fixture("stressed");
    let path = test_vectors_dir().join("policy").join("default.json");
    let mut json = load_json(&path);
    json["window"]["min_days"] = serde_json::json!(min_days);
    fx.policy = Policy::from_json(&serde_json::to_vec(&json).unwrap()).unwrap();
    fx
}

#[test]
fn statement_spanning_exactly_min_days_passes_check_15b() {
    let evaluation = stressed_with_min_days(185).evaluate().unwrap();
    assert_eq!(evaluation.outcome, Outcome::Reject);
    assert_eq!(evaluation.attestation, None);
}

#[test]
fn statement_one_day_under_min_days_is_window_too_short() {
    let fx = stressed_with_min_days(186);
    assert_eq!(
        fx.evaluate().map(|_| ()).map_err(|e| e.code()),
        Err("window_too_short")
    );
}
