//! Unit tests for the pieces of `evaluate` that need no fixtures: the
//! requested-range type and the error-code table (plan "Check order", FORMATS
//! §10). The pipeline itself is exercised end to end by `tests/vectors.rs`
//! and `tests/evaluate_boundaries.rs`. Written red-first by test-designer.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use super::*;
use crate::{
    DecryptError, ErrorCode, FiError, JwsError, KeyError, KeyMaterialError, MoneyError, ScoreError,
};

const MAX: i64 = u32::MAX as i64;

// --- FiDataRange -------------------------------------------------------

#[test]
fn range_accepts_an_ordinary_range_and_exposes_both_ends() {
    let range = FiDataRange::new(1_000, 2_000).unwrap();
    assert_eq!(range.from(), 1_000);
    assert_eq!(range.to(), 2_000);
}

#[test]
fn range_accepts_from_zero() {
    assert!(FiDataRange::new(0, 1).is_ok());
}

#[test]
fn range_accepts_to_exactly_u32_max() {
    assert!(FiDataRange::new(0, MAX).is_ok());
    assert!(FiDataRange::new(MAX - 1, MAX).is_ok());
}

#[test]
fn range_rejects_to_one_past_u32_max() {
    assert!(FiDataRange::new(0, MAX + 1).is_err());
}

#[test]
fn range_rejects_from_equal_to_to() {
    assert!(FiDataRange::new(5, 5).is_err());
    assert!(FiDataRange::new(0, 0).is_err());
}

#[test]
fn range_rejects_from_after_to() {
    assert!(FiDataRange::new(6, 5).is_err());
}

#[test]
fn range_rejects_negative_from() {
    assert!(FiDataRange::new(-1, 5).is_err());
}

#[test]
fn range_rejects_both_ends_negative() {
    assert!(FiDataRange::new(-10, -5).is_err());
}

#[test]
fn range_rejects_i64_extremes() {
    assert!(FiDataRange::new(i64::MIN, i64::MAX).is_err());
    assert!(FiDataRange::new(0, i64::MAX).is_err());
}

#[test]
fn range_error_code_is_bad_fi_data_range() {
    let err = FiDataRange::new(5, 5).unwrap_err();
    assert_eq!(err.code(), "bad_fi_data_range");
}

#[test]
fn every_range_rejection_reports_the_same_code() {
    for (from, to) in [(5, 5), (6, 5), (-1, 5), (0, MAX + 1)] {
        assert_eq!(
            FiDataRange::new(from, to).unwrap_err().code(),
            "bad_fi_data_range",
            "({from}, {to})"
        );
    }
}

// --- EvaluateError codes -----------------------------------------------

#[test]
fn own_layer_errors_have_their_own_codes() {
    let table: [(EvaluateError, &str); 8] = [
        (EvaluateError::BadFetchResponse, "bad_fetch_response"),
        (EvaluateError::SessionMismatch, "session_mismatch"),
        (EvaluateError::ConsentInvalid, "consent_invalid"),
        (EvaluateError::WindowMismatch, "window_mismatch"),
        (EvaluateError::WindowTooShort, "window_too_short"),
        (EvaluateError::WindowStale, "window_stale"),
        (EvaluateError::BadFipEnvelope, "bad_fip_envelope"),
        (
            EvaluateError::Score(ScoreError::TxnOutsideStatement),
            "window_mismatch",
        ),
    ];
    for (err, code) in table {
        assert_eq!(err.code(), code, "{err:?}");
    }
}

#[test]
fn aa_bad_signature_takes_the_aa_layer_code() {
    assert_eq!(
        EvaluateError::AaSignature(JwsError::BadSignature).code(),
        "bad_aa_signature"
    );
}

#[test]
fn consent_bad_signature_takes_the_consent_layer_code() {
    assert_eq!(
        EvaluateError::ConsentSignature(JwsError::BadSignature).code(),
        "bad_consent_signature"
    );
}

#[test]
fn fip_bad_signature_takes_the_fip_layer_code() {
    assert_eq!(
        EvaluateError::FipSignature(JwsError::BadSignature).code(),
        "bad_fip_signature"
    );
}

/// Builds one `JwsError` (they aren't `Copy`, so each layer gets a fresh one).
type MakeJwsError = fn() -> JwsError;

#[test]
fn other_jws_errors_keep_their_own_code_in_every_layer() {
    let jws_codes: [(MakeJwsError, &str); 6] = [
        (|| JwsError::Malformed, "bad_jws"),
        (|| JwsError::BadHeader, "bad_header"),
        (|| JwsError::BadAlg, "bad_alg"),
        (|| JwsError::UnknownKid, "unknown_kid"),
        (|| JwsError::BadPinnedKey, "bad_pinned_key"),
        (|| JwsError::SignFailed, "sign_failed"),
    ];
    for (make, code) in jws_codes {
        assert_eq!(EvaluateError::AaSignature(make()).code(), code);
        assert_eq!(EvaluateError::ConsentSignature(make()).code(), code);
        assert_eq!(EvaluateError::FipSignature(make()).code(), code);
    }
}

#[test]
fn key_material_errors_pass_their_own_codes() {
    assert_eq!(
        EvaluateError::KeyMaterial(KeyMaterialError::BadEncoding).code(),
        "bad_key_material"
    );
    assert_eq!(
        EvaluateError::KeyMaterial(KeyMaterialError::Key(KeyError::InvalidPoint)).code(),
        "invalid_point"
    );
    assert_eq!(
        EvaluateError::KeyMaterial(KeyMaterialError::Decrypt(DecryptError::BadNonce)).code(),
        "bad_nonce"
    );
}

#[test]
fn key_errors_pass_their_own_codes() {
    assert_eq!(
        EvaluateError::Key(KeyError::UnsupportedKey).code(),
        "bad_key_material"
    );
    assert_eq!(
        EvaluateError::Key(KeyError::ModeMismatch).code(),
        "bad_key_material"
    );
    assert_eq!(
        EvaluateError::Key(KeyError::InvalidPoint).code(),
        "invalid_point"
    );
}

#[test]
fn decrypt_errors_pass_their_own_codes() {
    assert_eq!(
        EvaluateError::Decrypt(DecryptError::DecryptFailed).code(),
        "decrypt_failed"
    );
    assert_eq!(
        EvaluateError::Decrypt(DecryptError::BadNonce).code(),
        "bad_nonce"
    );
}

#[test]
fn fi_errors_pass_their_own_codes() {
    assert_eq!(
        EvaluateError::Fi(FiError::UnsupportedFormat).code(),
        "unsupported_fi_format"
    );
    assert_eq!(
        EvaluateError::Fi(FiError::UnsupportedCurrency).code(),
        "unsupported_currency"
    );
    assert_eq!(EvaluateError::Fi(FiError::BadShape).code(), "bad_fi_data");
    assert_eq!(
        EvaluateError::Fi(FiError::BadMoney(MoneyError::NotWholePaise)).code(),
        "bad_fi_data"
    );
}

#[test]
fn score_errors_pass_their_own_codes() {
    assert_eq!(
        EvaluateError::Score(ScoreError::TxnOutsideStatement).code(),
        "window_mismatch"
    );
    assert_eq!(
        EvaluateError::Score(ScoreError::Overflow).code(),
        "bad_fi_data"
    );
}

// --- parse_consent -----------------------------------------------------------

const FROM: &str = "2025-09-26T00:00:00.000Z";
const TO: &str = "2026-09-26T00:00:00.000Z";

fn consent_json(status: &str, fi_types: &str, from: &str, to: &str) -> String {
    format!(
        r#"{{"consentId":"c1","status":"{status}","consentStart":"2026-09-25T10:00:00.000Z","consentExpiry":"2027-09-26T10:00:00.000Z","fiTypes":{fi_types},"FIDataRange":{{"from":"{from}","to":"{to}"}}}}"#
    )
}

fn consent_of(status: &str, fi_types: &str) -> Consent {
    let json = consent_json(status, fi_types, FROM, TO);
    parse_consent(json.as_bytes()).unwrap()
}

fn is_consent_invalid(result: Result<Consent, EvaluateError>) -> bool {
    matches!(result, Err(EvaluateError::ConsentInvalid))
}

#[test]
fn parse_consent_reads_a_valid_payload() {
    let consent = consent_of("ACTIVE", r#"["DEPOSIT"]"#);
    assert_eq!(consent.id, "c1");
    assert!(consent.active && consent.deposit);
    assert_eq!(consent.from, 1_758_844_800);
    assert_eq!(consent.to, 1_790_380_800);
    assert!(consent.start < consent.expiry);
}

#[test]
fn parse_consent_rejects_from_equal_to_to() {
    let json = consent_json("ACTIVE", r#"["DEPOSIT"]"#, FROM, FROM);
    assert!(is_consent_invalid(parse_consent(json.as_bytes())));
}

#[test]
fn parse_consent_rejects_from_after_to() {
    let json = consent_json("ACTIVE", r#"["DEPOSIT"]"#, TO, FROM);
    assert!(is_consent_invalid(parse_consent(json.as_bytes())));
}

#[test]
fn parse_consent_rejects_a_json_array() {
    assert!(is_consent_invalid(parse_consent(
        br#"["c1","ACTIVE","a","b",["DEPOSIT"],["a","b"]]"#
    )));
}

#[test]
fn parse_consent_rejects_a_missing_fi_types() {
    let json = r#"{"consentId":"c1","status":"ACTIVE","consentStart":"2026-09-25T10:00:00.000Z","consentExpiry":"2027-09-26T10:00:00.000Z","FIDataRange":{"from":"2025-09-26T00:00:00.000Z","to":"2026-09-26T00:00:00.000Z"}}"#;
    assert!(is_consent_invalid(parse_consent(json.as_bytes())));
}

// --- check_consent_active ------------------------------------------------------

#[test]
fn consent_without_deposit_is_not_active() {
    let consent = consent_of("ACTIVE", r#"["TERM_DEPOSIT"]"#);
    assert_eq!(
        check_consent_active(&consent, consent.start),
        Err(EvaluateError::ConsentInvalid)
    );
}

#[test]
fn revoked_consent_is_not_active() {
    let consent = consent_of("REVOKED", r#"["DEPOSIT"]"#);
    assert_eq!(
        check_consent_active(&consent, consent.start),
        Err(EvaluateError::ConsentInvalid)
    );
}

#[test]
fn valid_consent_is_active_inside_its_time_window() {
    let consent = consent_of("ACTIVE", r#"["DEPOSIT"]"#);
    assert_eq!(check_consent_active(&consent, consent.start), Ok(()));
}

// --- open_envelope -----------------------------------------------------------------

fn is_bad_envelope(plaintext: &[u8]) -> bool {
    matches!(open_envelope(plaintext), Err(EvaluateError::BadFipEnvelope))
}

#[test]
fn envelope_opens_and_decodes_the_statement() {
    let (fi, jws) = open_envelope(br#"{"fi":"aGVsbG8=","jws":"x..y"}"#).unwrap();
    assert_eq!(fi.as_slice(), b"hello");
    assert_eq!(jws, "x..y");
}

#[test]
fn envelope_allows_leading_whitespace() {
    let (fi, _) = open_envelope(b" \n\t{\"fi\":\"aGVsbG8=\",\"jws\":\"x..y\"}").unwrap();
    assert_eq!(fi.as_slice(), b"hello");
}

#[test]
fn envelope_rejects_a_json_array() {
    assert!(is_bad_envelope(br#"["aGVsbG8=","x..y"]"#));
}

#[test]
fn envelope_rejects_an_escape_in_fi() {
    assert!(is_bad_envelope(br#"{"fi":"aGVs\/G8=","jws":"x..y"}"#));
}

// An escape in a member we ignore would parse (and be copied into serde's
// unwiped scratch buffer) if only the borrowed members were checked.
#[test]
fn envelope_rejects_an_escape_in_an_ignored_member() {
    assert!(is_bad_envelope(
        br#"{"fi":"aGVsbG8=","jws":"x..y","extra":"a\nb"}"#
    ));
}

#[test]
fn envelope_rejects_a_duplicate_fi_key() {
    assert!(is_bad_envelope(
        br#"{"fi":"aGVsbG8=","fi":"aGVsbG8=","jws":"x..y"}"#
    ));
}

#[test]
fn envelope_rejects_non_base64_fi() {
    assert!(is_bad_envelope(br#"{"fi":"not base64 !","jws":"x..y"}"#));
}
