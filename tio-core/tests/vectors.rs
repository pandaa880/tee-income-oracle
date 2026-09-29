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
use tio_core::{verify_detached, KeyMaterial, Nonce};

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
        let plaintext = run_case(&dir)
            .unwrap_or_else(|code| panic!("case {}: expected Ok, got {code}", case_id(case)));

        // The decrypted FI matches the persona's plaintext exactly.
        let persona_id = case
            .get("persona_id")
            .and_then(Value::as_str)
            .expect("case.persona_id must be a string");
        let persona = load_json(
            &test_vectors_dir()
                .join("personas")
                .join(format!("{persona_id}.json")),
        );
        let expected_fi = persona
            .get("fi")
            .cloned()
            .unwrap_or_else(|| panic!("personas/{persona_id}.json has no fi"));
        let actual_fi: Value =
            serde_json::from_slice(&plaintext).expect("decrypted FI must be JSON");
        assert_eq!(
            actual_fi,
            expected_fi,
            "case {}: decrypted FI does not match personas/{persona_id}.json",
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
        let policy_hash = hex::encode(Sha256::digest(&policy_bytes));
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
