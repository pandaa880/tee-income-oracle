//! Reproduces every `test-vectors/` case with `tio-core` alone.
//!
//! The vectors are generated independently in TypeScript
//! (`sandbox-bank/src/vectors/`, `docs/FORMATS.md` §11): agreeing
//! byte-for-byte with a second implementation catches derivation bugs that
//! one implementation testing itself would never catch. This test never
//! generates or edits `test-vectors/` (AGENTS.md invariant 8); it only reads
//! the committed tree and manifest.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use std::{collections::BTreeSet, fs};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tio_core::{
    parse_deposit_fi, score, verify_detached, Features, KeyMaterial, Nonce, Outcome, Paise, Policy,
    Scores, Tier,
};

use common::{enclave_key_pair, key_mode, load_json, pinned_key, run_case, test_vectors_dir};

fn manifest_cases() -> Vec<Value> {
    let manifest = load_json(&test_vectors_dir().join("manifest.json"));
    manifest
        .get("cases")
        .and_then(Value::as_array)
        .cloned()
        .expect("manifest.json must have a cases array")
}

fn case_dir(case: &Value) -> std::path::PathBuf {
    let dir = case
        .get("dir")
        .and_then(Value::as_str)
        .expect("case.dir must be a string");
    test_vectors_dir().join(dir)
}

fn case_id(case: &Value) -> &str {
    case.get("id").and_then(Value::as_str).unwrap_or("<no id>")
}

/// Every positive case must pass every layer, and independently reproduce
/// what the generator claims it derived (`docs/FORMATS.md` §11).
#[test]
fn all_positive_cases_pass() {
    let cases = manifest_cases();
    let positive: Vec<&Value> = cases.iter().filter(|c| c["kind"] == "positive").collect();
    assert!(!positive.is_empty(), "manifest must list positive cases");

    for case in positive {
        let dir = case_dir(case);
        let evaluation = run_case(&dir)
            .unwrap_or_else(|code| panic!("case {}: expected Ok, got {code}", case_id(case)));

        // `evaluate` no longer exposes the decrypted FI, so "decrypts back to
        // the persona" is checked through its effect: the scores equal those
        // of scoring the persona's own FI directly.
        let persona_id = case
            .get("persona_id")
            .and_then(Value::as_str)
            .expect("case.persona_id must be a string");
        let (_, persona_scored) = persona_scores(persona_id);
        assert_eq!(
            evaluation.scores,
            persona_scored,
            "case {}: evaluated scores differ from scoring personas/{persona_id}.json",
            case_id(case)
        );

        // KeyMaterial::new(our rebuilt pair) matches what the fi_request body claims.
        let session = load_json(&dir.join("session.json"));
        let mode = key_mode(
            session
                .get("mode")
                .and_then(Value::as_str)
                .expect("session.mode must be a string"),
        );
        let pair = enclave_key_pair(mode);
        let enclave_nonce = Nonce::from_base64(
            session
                .get("enclave_nonce_b64")
                .and_then(Value::as_str)
                .expect("session.enclave_nonce_b64 must be a string"),
        )
        .expect("session.enclave_nonce_b64 must be a valid 32-byte nonce");
        let key_expiry_unix = session
            .get("key_expiry_unix")
            .and_then(Value::as_i64)
            .expect("session.key_expiry_unix must be an integer");
        let expected_key_material =
            KeyMaterial::new(pair.public_key(), &enclave_nonce, key_expiry_unix)
                .expect("KeyMaterial::new must succeed for a freshly generated key");

        let fi_request_body = fs::read(dir.join("fi_request.body"))
            .unwrap_or_else(|e| panic!("case {}: read fi_request.body: {e}", case_id(case)));
        let fi_request: Value = serde_json::from_slice(&fi_request_body)
            .unwrap_or_else(|e| panic!("case {}: fi_request.body is not JSON: {e}", case_id(case)));
        let actual_key_material: KeyMaterial =
            serde_json::from_value(fi_request.get("KeyMaterial").cloned().unwrap_or_else(|| {
                panic!("case {}: fi_request.body has no KeyMaterial", case_id(case))
            }))
            .unwrap_or_else(|e| panic!("case {}: bad fi_request KeyMaterial: {e}", case_id(case)));
        assert_eq!(
            actual_key_material,
            expected_key_material,
            "case {}: fi_request.body's KeyMaterial does not match KeyMaterial::new",
            case_id(case)
        );

        // fi_request.jws verifies with the FIU public key.
        let fiu = pinned_key("fiu");
        let fi_request_jws = fs::read_to_string(dir.join("fi_request.jws"))
            .unwrap_or_else(|e| panic!("case {}: read fi_request.jws: {e}", case_id(case)));
        verify_detached(
            &fi_request_jws,
            &fi_request_body,
            std::slice::from_ref(&fiu),
        )
        .unwrap_or_else(|e| panic!("case {}: fi_request.jws must verify: {e:?}", case_id(case)));

        // Hashes.
        let expected = &case["expected"];
        let consent_jws_bytes = fs::read(dir.join("consent.jws"))
            .unwrap_or_else(|e| panic!("case {}: read consent.jws: {e}", case_id(case)));
        let consent_hash = hex::encode(Sha256::digest(&consent_jws_bytes));
        assert_eq!(
            consent_hash,
            expected
                .get("consent_hash")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("case {}: expected.consent_hash missing", case_id(case))),
            "case {}: consent_hash mismatch",
            case_id(case)
        );

        let policy_bytes = fs::read(test_vectors_dir().join("policy").join("default.json"))
            .expect("read test-vectors/policy/default.json");
        // The generator's policy bytes must parse, and be exactly the JCS
        // bytes tio-core would produce itself (two independent canonicalizers).
        let policy = Policy::from_json(&policy_bytes)
            .unwrap_or_else(|e| panic!("case {}: default policy must parse: {e:?}", case_id(case)));
        assert_eq!(
            policy.canonical_json(),
            policy_bytes.as_slice(),
            "case {}: policy/default.json is not the JCS of the parsed policy",
            case_id(case)
        );
        let policy_hash = hex::encode(policy.hash().as_bytes());
        assert_eq!(
            policy_hash,
            expected
                .get("policy_hash")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("case {}: expected.policy_hash missing", case_id(case))),
            "case {}: policy_hash mismatch",
            case_id(case)
        );
        let policy_hash_file =
            fs::read_to_string(test_vectors_dir().join("policy").join("default.hash"))
                .expect("read test-vectors/policy/default.hash");
        assert_eq!(
            policy_hash,
            policy_hash_file.trim(),
            "case {}: policy/default.hash content does not match sha256(policy/default.json)",
            case_id(case)
        );

        // What `evaluate` itself reports must equal the generator's claims.
        assert_eq!(
            hex::encode(evaluation.policy_hash.as_bytes()),
            policy_hash,
            "case {}: evaluate policy_hash",
            case_id(case)
        );
        assert_eq!(
            hex::encode(evaluation.consent_hash),
            consent_hash,
            "case {}: evaluate consent_hash",
            case_id(case)
        );
    }
}

/// `window_from` / `window_to`, `payload_hex` and `msg_hex` from `evaluate`
/// equal the generator's independently built values (FORMATS §7, §8, §11);
/// a REJECT carries `null` for both and yields no attestation.
#[test]
fn positive_cases_match_expected_window_payload_and_message() {
    let cases = manifest_cases();
    let positive: Vec<&Value> = cases.iter().filter(|c| c["kind"] == "positive").collect();
    assert!(!positive.is_empty(), "manifest must list positive cases");

    for case in positive {
        let id = case_id(case);
        let evaluation = run_case(&case_dir(case))
            .unwrap_or_else(|code| panic!("case {id}: expected Ok, got {code}"));
        let expected = &case["expected"];

        assert_eq!(
            Some(i64::from(evaluation.window_from)),
            expected["window_from"].as_i64(),
            "case {id}: window_from"
        );
        assert_eq!(
            Some(i64::from(evaluation.window_to)),
            expected["window_to"].as_i64(),
            "case {id}: window_to"
        );

        let payload_hex = &expected["payload_hex"];
        let msg_hex = &expected["msg_hex"];
        if expected["tier"] == "REJECT" {
            assert!(payload_hex.is_null(), "case {id}: REJECT payload_hex null");
            assert!(msg_hex.is_null(), "case {id}: REJECT msg_hex null");
            assert_eq!(evaluation.outcome, Outcome::Reject, "case {id}: outcome");
            assert_eq!(evaluation.attestation, None, "case {id}: no attestation");
        } else {
            let attestation = evaluation
                .attestation
                .as_ref()
                .unwrap_or_else(|| panic!("case {id}: expected an attestation"));
            assert_eq!(
                Some(hex::encode(attestation.payload).as_str()),
                payload_hex.as_str(),
                "case {id}: payload_hex"
            );
            assert_eq!(
                Some(hex::encode(attestation.message).as_str()),
                msg_hex.as_str(),
                "case {id}: msg_hex"
            );
        }

        // `expected.json` carries the same claims as the manifest.
        let file = load_json(&case_dir(case).join("expected.json"));
        for key in ["window_from", "window_to", "payload_hex", "msg_hex"] {
            assert_eq!(file[key], expected[key], "case {id}: expected.json {key}");
        }
    }
}

/// Every negative case must fail at exactly the layer it broke
/// (`docs/FORMATS.md` §11): no other layer may mask it, and no layer may be
/// skipped.
#[test]
fn all_negative_cases_fail_with_expected_code() {
    let cases = manifest_cases();
    let negative: Vec<&Value> = cases.iter().filter(|c| c["kind"] == "negative").collect();
    assert!(!negative.is_empty(), "manifest must list negative cases");

    for case in negative {
        let dir = case_dir(case);
        let expected_code = case["expected"]
            .get("error_code")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("case {}: expected.error_code missing", case_id(case)));

        let result = run_case(&dir);
        assert_eq!(
            result,
            Err(expected_code),
            "case {}: expected error {expected_code}",
            case_id(case)
        );
    }
}

/// The slice-2e negatives (plan table) exist with the planned codes, so a
/// generator that silently drops one is caught here.
#[test]
fn manifest_lists_the_evaluate_negatives_with_their_codes() {
    let planned = [
        ("fetch_txnid_mismatch", "session_mismatch"),
        ("consent_id_mismatch", "session_mismatch"),
        ("consent_expired", "consent_invalid"),
        ("consent_not_started", "consent_invalid"),
        ("window_outside_consent", "window_mismatch"),
        ("window_too_short", "window_too_short"),
        ("window_stale", "window_stale"),
        ("statement_outside_window", "window_mismatch"),
        ("multi_fip_response", "bad_fetch_response"),
        ("multi_account_response", "bad_fetch_response"),
        ("fip_envelope_malformed", "bad_fip_envelope"),
        ("amount_three_decimals", "bad_fi_data"),
        ("amount_negative_string", "bad_fi_data"),
        ("fi_xml", "unsupported_fi_format"),
        ("order_txnid_before_decrypt", "session_mismatch"),
        ("order_stale_before_decrypt", "window_stale"),
    ];
    let cases = manifest_cases();
    for (id, code) in planned {
        let case = cases
            .iter()
            .find(|c| c["kind"] == "negative" && case_id(c) == id)
            .unwrap_or_else(|| panic!("manifest has no negative case {id}"));
        assert_eq!(case["expected"]["error_code"], code, "case {id}");
    }
}

/// The manifest and the directories on disk describe exactly the same set of
/// cases: no orphan directory the manifest forgot, no manifest entry whose
/// directory is missing.
#[test]
fn manifest_matches_directories() {
    let manifest = load_json(&test_vectors_dir().join("manifest.json"));
    assert_eq!(
        manifest.get("generator_version").and_then(Value::as_i64),
        Some(1),
        "manifest.json generator_version must be 1"
    );

    let cases = manifest_cases();
    let manifest_dirs: BTreeSet<String> = cases
        .iter()
        .map(|c| {
            c.get("dir")
                .and_then(Value::as_str)
                .expect("case.dir must be a string")
                .to_owned()
        })
        .collect();

    let mut disk_dirs = BTreeSet::new();
    for parent in ["vectors", "negative"] {
        let parent_path = test_vectors_dir().join(parent);
        let entries = fs::read_dir(&parent_path)
            .unwrap_or_else(|e| panic!("read_dir {}: {e}", parent_path.display()));
        for entry in entries {
            let entry = entry.expect("readable dir entry");
            if entry.file_type().expect("file type").is_dir() {
                let name = entry
                    .file_name()
                    .into_string()
                    .expect("directory name must be UTF-8");
                disk_dirs.insert(format!("{parent}/{name}"));
            }
        }
    }

    assert_eq!(
        manifest_dirs, disk_dirs,
        "manifest.json and the vectors/ + negative/ directories must list exactly the same cases"
    );
}

fn default_policy() -> Policy {
    let bytes = fs::read(test_vectors_dir().join("policy").join("default.json"))
        .expect("read test-vectors/policy/default.json");
    Policy::from_json(&bytes).expect("default policy must parse")
}

fn tier_name(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Tier(Tier::A) => "A",
        Outcome::Tier(Tier::B) => "B",
        Outcome::Tier(Tier::C) => "C",
        Outcome::Reject => "REJECT",
    }
}

fn number(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or_else(|| panic!("features.{key} must be an integer in {value}"))
}

fn count(value: &Value, key: &str) -> u32 {
    u32::try_from(number(value, key)).expect("count fits u32")
}

/// Reads a `Features` from the vector JSON keys (FORMATS §11): paise as plain
/// integers.
fn features_from_json(value: &Value) -> Features {
    Features {
        months: count(value, "months"),
        income_median: Paise::new(number(value, "income_median_paise")),
        obligation_median: Paise::new(number(value, "obligation_median_paise")),
        foir_bps: count(value, "foir_bps"),
        cv_bps: count(value, "cv_bps"),
        loans: count(value, "loans"),
        bounces: count(value, "bounces"),
        unmatched_emi_bounces: count(value, "unmatched_emi_bounces"),
        od_days: count(value, "od_days"),
    }
}

/// `evaluate` on the real fixtures reproduces the tier and features the
/// generator's independent TypeScript scorer wrote.
#[test]
fn positive_cases_score_to_the_expected_tier_and_features() {
    let cases = manifest_cases();
    let positive: Vec<&Value> = cases.iter().filter(|c| c["kind"] == "positive").collect();
    assert!(!positive.is_empty(), "manifest must list positive cases");

    for case in positive {
        let id = case_id(case);
        let got = run_case(&case_dir(case))
            .unwrap_or_else(|code| panic!("case {id}: expected Ok, got {code}"))
            .scores;

        let expected = &case["expected"];
        let tier = expected
            .get("tier")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("case {id}: expected.tier missing"));
        assert_eq!(tier_name(got.outcome), tier, "case {id}: tier");
        let features = expected
            .get("features")
            .unwrap_or_else(|| panic!("case {id}: expected.features missing"));
        assert_eq!(
            got.full,
            features_from_json(&features["full"]),
            "case {id}: full features"
        );
        assert_eq!(
            got.recent,
            features_from_json(&features["recent"]),
            "case {id}: recent features"
        );

        // `vectors/<case>/expected.json` carries the same claim as the manifest.
        let file = load_json(&case_dir(case).join("expected.json"));
        assert_eq!(
            file["tier"], expected["tier"],
            "case {id}: expected.json tier"
        );
        assert_eq!(
            file["features"], expected["features"],
            "case {id}: expected.json features"
        );
    }
}

fn persona_scores(persona_id: &str) -> (Value, Scores) {
    let persona = load_json(
        &test_vectors_dir()
            .join("personas")
            .join(format!("{persona_id}.json")),
    );
    let bytes = serde_json::to_vec(&persona["fi"]).expect("FI serializes");
    let fi = parse_deposit_fi(&bytes).expect("persona FI must parse");
    let scored = score(&fi, &default_policy()).expect("persona FI must score");
    (persona, scored)
}

fn assert_persona_tier(persona_id: &str, tier: &str) {
    let (persona, got) = persona_scores(persona_id);
    assert_eq!(
        persona["expected_tier"], tier,
        "{persona_id}: personas file expected_tier"
    );
    assert_eq!(tier_name(got.outcome), tier, "{persona_id}: scored tier");
}

#[test]
fn salaried_steady_scores_a() {
    assert_persona_tier("salaried_steady", "A");
}

#[test]
fn trader_lumpy_scores_b() {
    assert_persona_tier("trader_lumpy", "B");
}

#[test]
fn stressed_is_rejected_for_overdraft_with_its_loan_measured() {
    assert_persona_tier("stressed", "REJECT");
    let (_, got) = persona_scores("stressed");
    // Two paid EMIs make a loan (min_occurrences 2), so the debt counts. Its
    // bounces all come after the last payment (uncured), so none is
    // attributed; weeks of overdraft and the bounce count reject too.
    assert_eq!(got.full.loans, 1, "{:?}", got.full);
    assert!(got.full.unmatched_emi_bounces > 0, "{:?}", got.full);
    assert!(got.full.od_days >= 30, "{:?}", got.full);
    assert!(got.full.bounces > 3, "{:?}", got.full);
}

#[test]
fn declining_is_tier_b_over_the_full_window_and_c_over_the_recent_one() {
    assert_persona_tier("declining", "C");
    let (_, got) = persona_scores("declining");
    let (full, recent) = (got.full, got.recent);
    // Full: one bounce keeps it out of A, everything else fits B.
    assert_eq!(full.bounces, 1, "{full:?}");
    assert!(full.foir_bps <= 5500 && full.cv_bps <= 5000, "{full:?}");
    // Recent: the loan persists against shrunken income, so FOIR lands in C.
    assert!(
        recent.foir_bps > 5500 && recent.foir_bps <= 7000,
        "{recent:?}"
    );
    // The one EMI bounce is explained by the known loan missing that month.
    assert_eq!((full.loans, recent.loans), (1, 1));
    assert_eq!(full.unmatched_emi_bounces, 0);
    assert_eq!(recent.unmatched_emi_bounces, 0);
    assert!(full.od_days < 30);
}
