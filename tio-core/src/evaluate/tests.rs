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
