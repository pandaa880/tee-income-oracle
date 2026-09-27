#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use curve25519_dalek::{montgomery::MontgomeryPoint, scalar::Scalar};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde_json::Value;

use super::*;
use crate::ecdh::{finish_shared, KeyMode};

fn ecc_vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../test-vectors/golden/rahasya/ecc.json"
    ))
    .expect("ecc.json is valid JSON")
}

fn x25519_vector() -> Value {
    serde_json::from_str(include_str!(
        "../../../test-vectors/golden/rahasya/x25519.json"
    ))
    .expect("x25519.json is valid JSON")
}

fn hex32(s: &str) -> [u8; 32] {
    hex::decode(s)
        .expect("valid hex")
        .try_into()
        .expect("32 bytes")
}

fn hex12(s: &str) -> [u8; 12] {
    hex::decode(s)
        .expect("valid hex")
        .try_into()
        .expect("12 bytes")
}

fn vector_nonce(v: &Value, field: &str) -> Nonce {
    Nonce::from_base64(v[field].as_str().expect("string")).expect("valid 32-byte nonce")
}

/// Rebuilds one ecc.json vector's shared secret: BC's scalar is NOT
/// clamped, so this uses test-only raw scalar math (`docs/FORMATS.md` §3),
/// not `mul_clamped`.
fn wei25519_shared_secret(v: &Value) -> SharedSecret {
    let fiu_d_le = hex32(v["fiu"]["scalar_d_le_hex"].as_str().expect("string"));
    let fip_u = MontgomeryPoint(hex32(
        v["fip"]["public_montgomery_u_le_hex"]
            .as_str()
            .expect("string"),
    ));
    let s = Scalar::from_bytes_mod_order(fiu_d_le) * fip_u;
    finish_shared(KeyMode::Wei25519, &s).expect("nonzero shared secret")
}

/// Rebuilds the x25519.json shared secret with standard clamped X25519.
fn x25519_shared_secret(v: &Value) -> SharedSecret {
    let fip_priv = hex32(v["fip"]["private_key_raw_hex"].as_str().expect("string"));
    let fiu_pub = MontgomeryPoint(hex32(
        v["fiu"]["public_key_raw_hex"].as_str().expect("string"),
    ));
    let s = fiu_pub.mul_clamped(fip_priv);
    finish_shared(KeyMode::X25519, &s).expect("nonzero shared secret")
}

/// Derives the session key the way the FIU does: ours = FIU's nonce,
/// theirs = FIP's nonce. The XOR is symmetric, so this doesn't affect the
/// result, but it keeps the roles straight per the plan.
fn derive_key_for_vector(v: &Value, shared: SharedSecret) -> SessionKey {
    let ours = vector_nonce(v, "fiu_nonce_b64");
    let theirs = vector_nonce(v, "fip_nonce_b64");
    derive_session_key(&shared, &ours, &theirs).expect("valid 32-byte inputs never fail")
}

// ---------------------------------------------------------------------
// Golden vectors
// ---------------------------------------------------------------------

#[test]
fn derives_rahasya_aes_key_and_iv() {
    let vectors = ecc_vectors();
    for v in vectors["vectors"].as_array().expect("array") {
        let key = derive_key_for_vector(v, wei25519_shared_secret(v));
        assert_eq!(
            *key.aes_key(),
            hex32(v["aes_key_hex"].as_str().expect("string")),
            "vector {}",
            v["name"]
        );
        assert_eq!(
            *key.iv(),
            hex12(v["iv_hex"].as_str().expect("string")),
            "vector {}",
            v["name"]
        );
    }
}

#[test]
fn decrypts_rahasya_ciphertext_to_plaintext() {
    let vectors = ecc_vectors();
    for v in vectors["vectors"].as_array().expect("array") {
        let key = derive_key_for_vector(v, wei25519_shared_secret(v));
        let plaintext = decrypt(&key, v["ciphertext_b64"].as_str().expect("string"))
            .expect("valid ciphertext must decrypt");
        assert_eq!(
            &*plaintext,
            v["plaintext"].as_str().expect("string").as_bytes()
        );
    }
}

#[test]
fn reproduces_x25519_vector_key_iv_and_plaintext() {
    let v = x25519_vector();
    let key = derive_key_for_vector(&v, x25519_shared_secret(&v));

    assert_eq!(
        *key.aes_key(),
        hex32(v["aes_key_hex"].as_str().expect("string"))
    );
    assert_eq!(*key.iv(), hex12(v["iv_hex"].as_str().expect("string")));

    let plaintext = decrypt(&key, v["ciphertext_b64"].as_str().expect("string"))
        .expect("valid ciphertext must decrypt");
    assert_eq!(
        &*plaintext,
        v["plaintext"].as_str().expect("string").as_bytes()
    );
}

// ---------------------------------------------------------------------
// Nonce basics
// ---------------------------------------------------------------------

#[test]
fn nonce_base64_round_trips() {
    let mut rng = ChaCha20Rng::seed_from_u64(42);
    let nonce = Nonce::random(&mut rng);
    let decoded = Nonce::from_base64(&nonce.to_base64()).expect("valid nonce");
    assert_eq!(decoded, nonce);
}

// ---------------------------------------------------------------------
// Negatives
// ---------------------------------------------------------------------

#[test]
fn rejects_nonce_not_32_bytes() {
    for len in [31usize, 33] {
        let b64 = base64::engine::general_purpose::STANDARD.encode(vec![0u8; len]);
        let err = Nonce::from_base64(&b64).expect_err("wrong-length nonce must be rejected");
        assert_eq!(err, DecryptError::BadNonce);
        assert_eq!(err.code(), "bad_nonce");
    }
}

#[test]
fn rejects_nonce_that_is_not_base64() {
    for bad in ["!!!!", "AAAA=A"] {
        let err = Nonce::from_base64(bad).expect_err("invalid base64 must be rejected");
        assert_eq!(err, DecryptError::BadNonce, "{bad}");
        assert_eq!(err.code(), "bad_nonce");
    }
}

#[test]
fn rejects_tampered_ciphertext_body() {
    // Flips a byte of the ciphertext itself, not the tag: GCM must
    // authenticate the body, not only compare tags.
    let vectors = ecc_vectors();
    let v = &vectors["vectors"][0];
    let key = derive_key_for_vector(v, wei25519_shared_secret(v));
    let ciphertext_b64 = v["ciphertext_b64"].as_str().expect("string");
    assert!(decrypt(&key, ciphertext_b64).is_ok(), "baseline decrypts");

    let mut raw = base64::engine::general_purpose::STANDARD
        .decode(ciphertext_b64)
        .expect("valid base64");
    raw[0] ^= 0x01;
    let tampered = base64::engine::general_purpose::STANDARD.encode(&raw);

    let err = decrypt(&key, &tampered).expect_err("a tampered body must be rejected");
    assert_eq!(err, DecryptError::DecryptFailed);
    assert_eq!(err.code(), "decrypt_failed");
}

#[test]
fn rejects_tampered_ciphertext() {
    let vectors = ecc_vectors();
    let v = &vectors["vectors"][0];
    let key = derive_key_for_vector(v, wei25519_shared_secret(v));
    let ciphertext_b64 = v["ciphertext_b64"].as_str().expect("string");

    // Baseline: the untouched ciphertext decrypts.
    assert!(decrypt(&key, ciphertext_b64).is_ok());

    let mut raw = base64::engine::general_purpose::STANDARD
        .decode(ciphertext_b64)
        .expect("valid base64");
    let last = raw.len() - 1;
    raw[last] ^= 0x01;
    let tampered = base64::engine::general_purpose::STANDARD.encode(&raw);

    let err = decrypt(&key, &tampered).expect_err("a tampered ciphertext must be rejected");
    assert_eq!(err, DecryptError::DecryptFailed);
    assert_eq!(err.code(), "decrypt_failed");
}

#[test]
fn rejects_ciphertext_shorter_than_tag() {
    let vectors = ecc_vectors();
    let v = &vectors["vectors"][0];
    let key = derive_key_for_vector(v, wei25519_shared_secret(v));

    // 8 bytes, well under the mandatory 16-byte GCM tag.
    let short = base64::engine::general_purpose::STANDARD.encode([0u8; 8]);
    let err = decrypt(&key, &short).expect_err("ciphertext shorter than the tag must be rejected");
    assert_eq!(err, DecryptError::DecryptFailed);
    assert_eq!(err.code(), "decrypt_failed");
}

#[test]
fn rejects_bad_base64_ciphertext() {
    let vectors = ecc_vectors();
    let v = &vectors["vectors"][0];
    let key = derive_key_for_vector(v, wei25519_shared_secret(v));

    let err = decrypt(&key, "not-valid-base64!!").expect_err("bad base64 must be rejected");
    assert_eq!(err, DecryptError::DecryptFailed);
    assert_eq!(err.code(), "decrypt_failed");
}

#[test]
fn rejects_wrong_session_key() {
    let vectors = ecc_vectors();
    let basic = &vectors["vectors"][0];
    let other_session = &vectors["vectors"][1];

    let shared = wei25519_shared_secret(basic);
    let ours = vector_nonce(basic, "fiu_nonce_b64");
    // A nonce from an unrelated session: the derived key diverges silently.
    let wrong_theirs = vector_nonce(other_session, "fip_nonce_b64");
    let key =
        derive_session_key(&shared, &ours, &wrong_theirs).expect("valid 32-byte inputs never fail");

    let err = decrypt(&key, basic["ciphertext_b64"].as_str().expect("string"))
        .expect_err("decrypting with the wrong session key must be rejected");
    assert_eq!(err, DecryptError::DecryptFailed);
    assert_eq!(err.code(), "decrypt_failed");
}

#[test]
fn decrypt_error_codes_match_spec() {
    assert_eq!(DecryptError::BadNonce.code(), "bad_nonce");
    assert_eq!(DecryptError::DecryptFailed.code(), "decrypt_failed");
}
