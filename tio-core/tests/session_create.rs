//! Session-create building blocks (`docs/FORMATS.md` §5.1, §5.3, §8.1):
//! `build_fi_request`, `consent_ref` and `FiuSigningKey::public_jwk_jcs`.
//!
//! `build_fi_request` is cross-checked byte for byte against the
//! TypeScript-generated `fi_request.body` of every positive vector, so two
//! independent implementations must agree (FORMATS §11).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use std::{fs, sync::OnceLock};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand_chacha::{rand_core::SeedableRng, ChaCha20Rng};
use rsa::{BigUint, Pkcs1v15Sign, RsaPrivateKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tio_core::{
    build_fi_request, consent_ref, parse_rebit_timestamp, verify_compact, verify_detached,
    ConsentRef, ErrorCode, EvaluateError, FiRequest, FiuSigningKey, JwsError, KeyMaterial,
    PinnedKey,
};

use common::{enclave_key_pair, key_mode, load_json, pinned_key, test_vectors_dir, CaseFixture};

fn positive_dirs() -> Vec<std::path::PathBuf> {
    let manifest = load_json(&test_vectors_dir().join("manifest.json"));
    let dirs: Vec<_> = manifest["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .filter(|c| c["kind"] == "positive")
        .map(|c| test_vectors_dir().join(c["dir"].as_str().expect("dir")))
        .collect();
    assert!(dirs.len() >= 6, "expected the six positive vectors");
    dirs
}

fn signature_segment(jws: &str) -> String {
    jws.trim().rsplit('.').next().expect("segment").to_owned()
}

// --- build_fi_request ------------------------------------------------------

fn build_for_vector(dir: &std::path::Path) -> Vec<u8> {
    let fx = CaseFixture::load(dir);
    let session = load_json(&dir.join("session.json"));
    let key_expiry = session["key_expiry_unix"]
        .as_i64()
        .expect("key_expiry_unix");
    let key_pair = enclave_key_pair(key_mode(session["mode"].as_str().expect("mode")));
    let key_material =
        KeyMaterial::new(key_pair.public_key(), &fx.nonce, key_expiry).expect("key material");
    let consent = ConsentRef {
        id: fx.consent_id.clone(),
        signature: signature_segment(&fx.consent_jws),
    };
    build_fi_request(&FiRequest {
        txnid: &fx.txnid,
        now: fx.clock.now,
        consent: &consent,
        range: fx.range,
        key_material: &key_material,
    })
    .expect("build_fi_request")
}

#[test]
fn fi_request_equals_every_positive_vector_body_byte_for_byte() {
    for dir in positive_dirs() {
        let expected = fs::read(dir.join("fi_request.body")).expect("fi_request.body");
        let built = build_for_vector(&dir);
        assert_eq!(
            String::from_utf8_lossy(&built),
            String::from_utf8_lossy(&expected),
            "{}",
            dir.display()
        );
        assert_eq!(built, expected, "{}", dir.display());
    }
}

#[test]
fn fi_request_is_deterministic() {
    let dir = positive_dirs().remove(0);
    assert_eq!(build_for_vector(&dir), build_for_vector(&dir));
}

#[test]
fn fi_request_is_compact_json_with_members_in_spec_order() {
    let dir = positive_dirs().remove(0);
    let body = String::from_utf8(build_for_vector(&dir)).expect("utf8");
    assert!(!body.contains('\n') && !body.contains(": ") && !body.contains(", "));
    let positions: Vec<usize> = [
        "\"ver\":",
        "\"timestamp\":",
        "\"txnid\":",
        "\"Consent\":",
        "\"FIDataRange\":",
        "\"KeyMaterial\":",
    ]
    .iter()
    .map(|m| body.find(m).unwrap_or_else(|| panic!("missing {m}")))
    .collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "member order");
    let parsed: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(parsed["ver"], "1.1.3");
}

// --- consent_ref -----------------------------------------------------------

fn vector_consent(case_dir: &str) -> String {
    let path = test_vectors_dir().join(case_dir).join("consent.jws");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[test]
fn consent_ref_returns_the_consent_id_and_the_received_signature_segment() {
    let dir = test_vectors_dir().join("vectors").join("salaried_steady");
    let fx = CaseFixture::load(&dir);
    let got = consent_ref(&fx.consent_jws, &fx.aa).expect("consent_ref");
    assert_eq!(got.id, fx.consent_id);
    assert_eq!(got.signature, signature_segment(&fx.consent_jws));
}

#[test]
fn consent_ref_matches_session_json_for_every_positive_vector() {
    for dir in positive_dirs() {
        let fx = CaseFixture::load(&dir);
        let session = load_json(&dir.join("session.json"));
        let got = consent_ref(&fx.consent_jws, &fx.aa).expect("consent_ref");
        assert_eq!(got.id, session["consent_id"].as_str().expect("id"));
        assert_eq!(got.signature, signature_segment(&fx.consent_jws));
    }
}

#[test]
fn consent_ref_rejects_a_tampered_consent_as_bad_consent_signature() {
    let jws = vector_consent("negative/consent_tampered");
    let err = consent_ref(&jws, &[pinned_key("aa")]).expect_err("tampered");
    assert_eq!(err.code(), "bad_consent_signature");
    assert_eq!(err, EvaluateError::ConsentSignature(JwsError::BadSignature));
}

#[test]
fn consent_ref_rejects_a_consent_from_an_unpinned_key_as_unknown_kid() {
    let jws = vector_consent("vectors/salaried_steady");
    let err = consent_ref(&jws, &[pinned_key("fip")]).expect_err("only fip pinned");
    assert_eq!(err.code(), "unknown_kid");
}

#[test]
fn consent_ref_rejects_a_malformed_jws() {
    let err = consent_ref("not-a-jws", &[pinned_key("aa")]).expect_err("malformed");
    assert_eq!(err.code(), "bad_jws");
}

#[test]
fn consent_ref_with_no_pinned_keys_is_unknown_kid() {
    let jws = vector_consent("vectors/salaried_steady");
    assert_eq!(
        consent_ref(&jws, &[]).expect_err("none").code(),
        "unknown_kid"
    );
}

#[test]
fn consent_ref_does_not_check_consent_status_evaluate_does() {
    // §10.1: create only reads the id; evaluate re-checks ACTIVE etc.
    let jws = vector_consent("negative/consent_not_active");
    let got = consent_ref(&jws, &[pinned_key("aa")]).expect("id is readable");
    assert!(!got.id.is_empty());
}

/// Signs `payload` as a compact RS256 JWS with the committed TEST AA key.
fn sign_with_test_aa_key(payload: &[u8]) -> String {
    let path = test_vectors_dir()
        .join("keys")
        .join("aa.test-private.jwk.json");
    let jwk = load_json(&path);
    let int = |m: &str| {
        BigUint::from_bytes_be(
            &URL_SAFE_NO_PAD
                .decode(jwk[m].as_str().expect("member"))
                .expect("b64url"),
        )
    };
    let key =
        RsaPrivateKey::from_components(int("n"), int("e"), int("d"), vec![int("p"), int("q")])
            .expect("test key");
    let header = format!(
        r#"{{"alg":"RS256","kid":"{}"}}"#,
        jwk["kid"].as_str().expect("kid")
    );
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header),
        URL_SAFE_NO_PAD.encode(payload)
    );
    let signature = key
        .sign(
            Pkcs1v15Sign::new::<Sha256>(),
            &Sha256::digest(signing_input.as_bytes()),
        )
        .expect("sign");
    format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature))
}

#[test]
fn test_signer_helper_produces_verifiable_jws() {
    let jws = sign_with_test_aa_key(b"{\"x\":1}");
    assert_eq!(
        verify_compact(&jws, &[pinned_key("aa")]).expect("verifies"),
        b"{\"x\":1}"
    );
}

#[test]
fn consent_ref_rejects_a_validly_signed_non_consent_payload_as_consent_invalid() {
    let jws = sign_with_test_aa_key(br#"{"hello":"world"}"#);
    let err = consent_ref(&jws, &[pinned_key("aa")]).expect_err("not a consent");
    assert_eq!(err, EvaluateError::ConsentInvalid);
    assert_eq!(err.code(), "consent_invalid");
}

#[test]
fn consent_ref_rejects_a_signed_payload_that_is_not_json_as_consent_invalid() {
    let jws = sign_with_test_aa_key(b"plain text");
    let err = consent_ref(&jws, &[pinned_key("aa")]).expect_err("not json");
    assert_eq!(err.code(), "consent_invalid");
}

// --- FiuSigningKey::public_jwk_jcs ----------------------------------------

const UUID_KID: &str = "5d5a0c7e-3b0a-4a58-9a39-0123456789ab";
const AWKWARD_KID: &str = "a\"b\\c";

fn seeded_key(kid: &str, seed: u64) -> FiuSigningKey {
    let mut rng = ChaCha20Rng::seed_from_u64(seed);
    FiuSigningKey::generate(kid.to_owned(), &mut rng).expect("generate")
}

fn shared_key() -> &'static FiuSigningKey {
    static KEY: OnceLock<FiuSigningKey> = OnceLock::new();
    KEY.get_or_init(|| seeded_key(UUID_KID, 7))
}

fn jcs_n(jcs: &str) -> String {
    let prefix = format!(r#"{{"e":"AQAB","kid":"{UUID_KID}","kty":"RSA","n":""#);
    jcs.strip_prefix(&prefix)
        .and_then(|rest| rest.strip_suffix("\"}"))
        .unwrap_or_else(|| panic!("unexpected JCS shape: {jcs}"))
        .to_owned()
}

#[test]
fn public_jwk_jcs_has_exactly_e_kid_kty_n_in_that_order_with_no_whitespace() {
    let jcs = String::from_utf8(shared_key().public_jwk_jcs().expect("jcs")).expect("utf8");
    let n = jcs_n(&jcs);
    assert!(!n.is_empty());
    assert!(!jcs.contains(char::is_whitespace));
}

#[test]
fn public_jwk_jcs_modulus_is_base64url_without_padding_big_endian_minimal_2048_bit() {
    let jcs = String::from_utf8(shared_key().public_jwk_jcs().expect("jcs")).expect("utf8");
    let n = jcs_n(&jcs);
    assert!(n
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    let bytes = URL_SAFE_NO_PAD.decode(&n).expect("b64url no pad");
    assert_eq!(bytes.len(), 256);
    assert!(
        bytes[0] >= 0x80,
        "top bit set: minimal length 2048-bit modulus"
    );
}

#[test]
fn public_jwk_jcs_is_stable_across_calls() {
    let key = shared_key();
    assert_eq!(
        key.public_jwk_jcs().expect("a"),
        key.public_jwk_jcs().expect("b")
    );
}

#[test]
fn public_jwk_jcs_parses_back_and_verifies_a_detached_signature() {
    let key = shared_key();
    let jcs = key.public_jwk_jcs().expect("jcs");
    let pinned = PinnedKey::from_jwk(&jcs).expect("from_jwk");
    assert_eq!(pinned.kid(), UUID_KID);

    let body = br#"{"ver":"1.1.3"}"#;
    let mut rng = ChaCha20Rng::seed_from_u64(99);
    let jws = key.sign_detached(body, &mut rng).expect("sign");
    verify_detached(&jws, body, std::slice::from_ref(&pinned))
        .expect("verifies with the published JWK");
    assert_eq!(
        verify_detached(&jws, b"other", &[pinned]),
        Err(JwsError::BadSignature)
    );
}

#[test]
fn public_jwk_jcs_escapes_awkward_key_ids_as_jcs_and_still_parses() {
    let key = seeded_key(AWKWARD_KID, 11);
    let jcs = String::from_utf8(key.public_jwk_jcs().expect("jcs")).expect("utf8");
    assert!(
        jcs.starts_with(r#"{"e":"AQAB","kid":"a\"b\\c","kty":"RSA","n":""#),
        "{jcs}"
    );
    let parsed: Value = serde_json::from_str(&jcs).expect("json");
    assert_eq!(parsed["kid"], AWKWARD_KID);
    assert_eq!(
        PinnedKey::from_jwk(jcs.as_bytes()).expect("from_jwk").kid(),
        AWKWARD_KID
    );
}

#[test]
fn public_jwk_jcs_carries_no_private_members() {
    let jcs = String::from_utf8(shared_key().public_jwk_jcs().expect("jcs")).expect("utf8");
    let parsed: Value = serde_json::from_str(&jcs).expect("json");
    let mut keys: Vec<&str> = parsed
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["e", "kid", "kty", "n"]);
}

#[test]
fn fi_request_range_from_session_json_matches_vector_timestamps() {
    // Guards the fixture assumption used above: range ends are UTC midnights.
    let dir = positive_dirs().remove(0);
    let session = load_json(&dir.join("session.json"));
    let to =
        parse_rebit_timestamp(session["fi_data_range"]["to"].as_str().expect("to")).expect("ts");
    assert_eq!(to % 86_400, 0);
}
