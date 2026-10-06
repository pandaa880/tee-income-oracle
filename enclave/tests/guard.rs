//! Startup guard (FORMATS §2) and the compiled-in pinned keys.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tio_enclave::{
    guard::{check_pinned, GuardError, TEST_KEY_KIDS, TEST_KEY_MODULUS_SHA256},
    pinned::{load_compiled, Pinned, AA_JWKS, FIP_JWKS},
};

use common::{jwk_kid, load_json, pinned_demo_bytes, read_bytes, test_key_bytes, vectors_dir};

const TEST_KEY_NAMES: [&str; 4] = ["aa", "fip", "fiu", "rogue"];
const OTHER_UUID: &str = "11111111-2222-4333-8444-555555555555";

fn with_member(jwk: &[u8], member: &str, value: Value) -> Vec<u8> {
    let mut json: Value = serde_json::from_slice(jwk).expect("json");
    json[member] = value;
    serde_json::to_vec(&json).expect("serialize")
}

fn modulus_sha256_hex(jwk: &Value) -> String {
    let n = URL_SAFE_NO_PAD
        .decode(jwk["n"].as_str().expect("n"))
        .expect("b64url");
    hex::encode(Sha256::digest(n))
}

// --- check_pinned: test keys are refused -----------------------------------

#[test]
fn every_committed_test_public_key_is_refused() {
    for name in TEST_KEY_NAMES {
        let jwk = test_key_bytes(name);
        assert_eq!(
            check_pinned(&[jwk.as_slice()]),
            Err(GuardError::TestKeyPinned),
            "{name}"
        );
    }
}

#[test]
fn a_test_key_with_a_renamed_kid_is_still_refused_by_its_modulus() {
    for name in TEST_KEY_NAMES {
        let renamed = with_member(&test_key_bytes(name), "kid", Value::from(OTHER_UUID));
        assert_eq!(
            check_pinned(&[renamed.as_slice()]),
            Err(GuardError::TestKeyPinned),
            "{name}"
        );
    }
}

#[test]
fn a_demo_key_given_a_test_kid_is_refused_by_kid() {
    for kid in TEST_KEY_KIDS {
        let renamed = with_member(&pinned_demo_bytes("aa"), "kid", Value::from(*kid));
        assert_eq!(
            check_pinned(&[renamed.as_slice()]),
            Err(GuardError::TestKeyPinned),
            "{kid}"
        );
    }
}

#[test]
fn one_test_key_among_good_keys_fails_the_whole_set() {
    let aa = pinned_demo_bytes("aa");
    let fip = pinned_demo_bytes("fip");
    let fiu = test_key_bytes("fiu");
    assert_eq!(
        check_pinned(&[aa.as_slice(), fip.as_slice(), fiu.as_slice()]),
        Err(GuardError::TestKeyPinned)
    );
    assert_eq!(
        check_pinned(&[fiu.as_slice(), aa.as_slice()]),
        Err(GuardError::TestKeyPinned)
    );
}

#[test]
fn the_golden_rfc_keys_are_refused() {
    for file in ["a2.json", "rfc7520.json"] {
        let golden = load_json(&vectors_dir().join("golden").join("rfc7515").join(file));
        let mut jwk = golden["jwk"].clone();
        // Public members only, as a pinned file would be.
        let object = jwk.as_object_mut().expect("jwk object");
        object.retain(|k, _| matches!(k.as_str(), "kty" | "n" | "e" | "kid"));
        object
            .entry("kid")
            .or_insert_with(|| Value::from(OTHER_UUID));
        let bytes = serde_json::to_vec(&jwk).expect("serialize");
        assert_eq!(
            check_pinned(&[bytes.as_slice()]),
            Err(GuardError::TestKeyPinned),
            "{file}"
        );
    }
}

// --- check_pinned: demo keys pass --------------------------------------------

#[test]
fn the_pinned_demo_keys_pass_together_and_alone() {
    let aa = pinned_demo_bytes("aa");
    let fip = pinned_demo_bytes("fip");
    assert_eq!(check_pinned(&[aa.as_slice(), fip.as_slice()]), Ok(()));
    assert_eq!(check_pinned(&[aa.as_slice()]), Ok(()));
    assert_eq!(check_pinned(&[fip.as_slice()]), Ok(()));
}

#[test]
fn the_demo_kids_are_not_in_the_deny_list() {
    for name in ["aa", "fip"] {
        let kid = jwk_kid(&pinned_demo_bytes(name));
        assert!(!TEST_KEY_KIDS.contains(&kid.as_str()), "{name}");
    }
}

// --- check_pinned: malformed input --------------------------------------------

#[test]
fn garbage_is_a_bad_pinned_key() {
    let cases: [&[u8]; 6] = [
        b"not json",
        b"",
        b"{}",
        b"[]",
        br#"{"kty":"RSA","e":"AQAB","kid":"x"}"#,
        br#"{"kty":"RSA","n":"!!!not base64url!!!","e":"AQAB","kid":"x"}"#,
    ];
    for bytes in cases {
        assert_eq!(
            check_pinned(&[bytes]),
            Err(GuardError::BadPinnedKey),
            "{}",
            String::from_utf8_lossy(bytes)
        );
    }
}

#[test]
fn a_non_string_kid_is_a_bad_pinned_key() {
    let bad = with_member(&pinned_demo_bytes("aa"), "kid", Value::from(7));
    assert_eq!(
        check_pinned(&[bad.as_slice()]),
        Err(GuardError::BadPinnedKey)
    );
}

#[test]
fn guard_error_codes_are_stable() {
    assert_eq!(GuardError::TestKeyPinned.code(), "test_key_pinned");
    assert_eq!(GuardError::BadPinnedKey.code(), "bad_pinned_key");
}

// --- deny-list coverage -------------------------------------------------------

fn rsa_jwks_under_test_vectors() -> Vec<(String, Value)> {
    let mut found = Vec::new();
    let keys_dir = vectors_dir().join("keys");
    for entry in std::fs::read_dir(&keys_dir).expect("keys dir") {
        let path = entry.expect("entry").path();
        let name = path
            .file_name()
            .expect("name")
            .to_string_lossy()
            .into_owned();
        if name.ends_with(".jwk.json") {
            found.push((name, load_json(&path)));
        }
    }
    for file in ["a2.json", "rfc7520.json"] {
        let golden = load_json(&vectors_dir().join("golden").join("rfc7515").join(file));
        found.push((format!("golden/{file}"), golden["jwk"].clone()));
    }
    assert!(found.len() >= 10, "expected 8 key files + 2 golden keys");
    found
}

#[test]
fn every_rsa_key_under_test_vectors_has_its_modulus_hash_in_the_deny_list() {
    for (name, jwk) in rsa_jwks_under_test_vectors() {
        assert_eq!(jwk["kty"], "RSA", "{name}");
        let hash = modulus_sha256_hex(&jwk);
        assert!(
            TEST_KEY_MODULUS_SHA256.contains(&hash.as_str()),
            "{name}: modulus sha256 {hash} missing from TEST_KEY_MODULUS_SHA256"
        );
    }
}

#[test]
fn every_kid_under_test_vectors_is_in_the_deny_list() {
    for (name, jwk) in rsa_jwks_under_test_vectors() {
        if let Some(kid) = jwk["kid"].as_str() {
            assert!(TEST_KEY_KIDS.contains(&kid), "{name}: kid {kid}");
        }
    }
}

#[test]
fn the_deny_list_has_well_formed_entries() {
    for hash in TEST_KEY_MODULUS_SHA256 {
        assert_eq!(hash.len(), 64, "{hash}");
        assert!(
            hash.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "{hash}"
        );
    }
}

#[test]
fn no_demo_modulus_is_in_the_deny_list() {
    for name in ["aa", "fip"] {
        let jwk: Value = serde_json::from_slice(&pinned_demo_bytes(name)).expect("json");
        assert!(!TEST_KEY_MODULUS_SHA256.contains(&modulus_sha256_hex(&jwk).as_str()));
    }
}

// --- compiled-in pinned keys --------------------------------------------------

#[test]
fn compiled_in_jwks_are_the_files_under_enclave_pinned() {
    assert_eq!(AA_JWKS, [pinned_demo_bytes("aa").as_slice()]);
    assert_eq!(FIP_JWKS, [pinned_demo_bytes("fip").as_slice()]);
}

#[test]
fn load_compiled_passes_the_guard_and_lists_aa_then_fip_kids() {
    let pinned = load_compiled().expect("compiled keys are demo keys");
    assert_eq!(
        pinned.kids(),
        vec![
            jwk_kid(&pinned_demo_bytes("aa")),
            jwk_kid(&pinned_demo_bytes("fip"))
        ]
    );
    assert_eq!(pinned.aa.len(), 1);
    assert_eq!(pinned.fip.len(), 1);
}

#[test]
fn pinned_parse_accepts_test_keys_without_running_the_guard() {
    let aa = test_key_bytes("aa");
    let fip = test_key_bytes("fip");
    let pinned = Pinned::parse(&[aa.as_slice()], &[fip.as_slice()]).expect("parse");
    assert_eq!(pinned.aa[0].kid(), jwk_kid(&aa));
    assert_eq!(pinned.fip[0].kid(), jwk_kid(&fip));
    assert_eq!(pinned.kids(), vec![jwk_kid(&aa), jwk_kid(&fip)]);
}

#[test]
fn pinned_parse_rejects_a_bad_jwk_in_either_list() {
    let good = test_key_bytes("aa");
    assert_eq!(
        Pinned::parse(&[b"garbage".as_slice()], &[good.as_slice()]).err(),
        Some(GuardError::BadPinnedKey)
    );
    assert_eq!(
        Pinned::parse(&[good.as_slice()], &[b"garbage".as_slice()]).err(),
        Some(GuardError::BadPinnedKey)
    );
}

#[test]
fn pinned_parse_rejects_a_jwk_that_carries_private_members() {
    let private = read_bytes(&vectors_dir().join("keys").join("aa.test-private.jwk.json"));
    let fip = test_key_bytes("fip");
    assert_eq!(
        Pinned::parse(&[private.as_slice()], &[fip.as_slice()]).err(),
        Some(GuardError::BadPinnedKey)
    );
}
