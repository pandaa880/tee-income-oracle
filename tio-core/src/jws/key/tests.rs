#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use rsa::signature::{SignatureEncoding, Signer};
use rsa::traits::PublicKeyParts;
use rsa::{pkcs1v15::SigningKey, BigUint, RsaPrivateKey, RsaPublicKey};
use serde_json::Value;
use sha2::Sha512;

use super::*;
use crate::{verify_detached, ErrorCode};

// A test-only `kid` for the RFC 7515 A.2 key: the RFC's JWK has no `kid` of
// its own (`docs/FORMATS.md` §4 requires one), so pinning it needs one made
// up here, never edited into the fixture.
const A2_TEST_KID: &str = "11111111-1111-4111-8111-111111111111";

fn a2_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../test-vectors/golden/rfc7515/a2.json"
    ))
    .expect("a2.json is valid JSON")
}

fn field<'a>(jwk: &'a Value, name: &str) -> &'a str {
    jwk[name]
        .as_str()
        .unwrap_or_else(|| panic!("{name} is a string"))
}

fn biguint(jwk: &Value, name: &str) -> BigUint {
    BigUint::from_bytes_be(
        &URL_SAFE_NO_PAD
            .decode(field(jwk, name))
            .expect("valid base64url"),
    )
}

fn rsa_private_key_from_jwk(jwk: &Value) -> RsaPrivateKey {
    RsaPrivateKey::from_components(
        biguint(jwk, "n"),
        biguint(jwk, "e"),
        biguint(jwk, "d"),
        vec![biguint(jwk, "p"), biguint(jwk, "q")],
    )
    .expect("a valid RFC RSA key")
}

fn rsa_public_key_from_jwk(jwk: &Value) -> RsaPublicKey {
    RsaPublicKey::new(biguint(jwk, "n"), biguint(jwk, "e")).expect("a valid RFC RSA public key")
}

/// Builds the bytes of a public RSA JWK `{kty,n,e,kid}`, the shape
/// `PinnedKey::from_jwk` accepts (`docs/FORMATS.md` §4).
fn pinned_jwk_json(n_b64: &str, e_b64: &str, kid: &str) -> Vec<u8> {
    format!(r#"{{"kty":"RSA","n":"{n_b64}","e":"{e_b64}","kid":"{kid}"}}"#).into_bytes()
}

fn public_components_b64(key: &RsaPublicKey) -> (String, String) {
    (
        URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),
        URL_SAFE_NO_PAD.encode(key.e().to_bytes_be()),
    )
}

// ---------------------------------------------------------------------
// PinnedKey::from_jwk
// ---------------------------------------------------------------------

#[test]
fn from_jwk_accepts_a_valid_rsa_key_and_exposes_its_kid() {
    let a2 = a2_fixture();
    let json = pinned_jwk_json(field(&a2["jwk"], "n"), field(&a2["jwk"], "e"), A2_TEST_KID);

    let key = PinnedKey::from_jwk(&json).expect("a valid RSA public JWK must parse");
    assert_eq!(key.kid(), A2_TEST_KID);
}

#[test]
fn from_jwk_rejects_non_rsa_kty() {
    let json = br#"{"kty":"EC","crv":"P-256","x":"AAAA","y":"AAAA","kid":"k1"}"#;

    let err = PinnedKey::from_jwk(json).expect_err("an EC key must be rejected");
    assert_eq!(err, JwsError::BadPinnedKey);
    assert_eq!(err.code(), "bad_pinned_key");
}

/// Valid RSA `n`/`e` under a non-RSA `kty`, so no other check fires first.
#[test]
fn from_jwk_rejects_a_wrong_kty_with_valid_rsa_members() {
    let a2 = a2_fixture();
    let json = format!(
        r#"{{"kty":"oct","n":"{}","e":"{}","kid":"{A2_TEST_KID}"}}"#,
        field(&a2["jwk"], "n"),
        field(&a2["jwk"], "e")
    )
    .into_bytes();

    let err = PinnedKey::from_jwk(&json).expect_err("kty must be RSA");
    assert_eq!(err, JwsError::BadPinnedKey);
}

#[test]
fn from_jwk_rejects_missing_n() {
    let a2 = a2_fixture();
    let json = format!(
        r#"{{"kty":"RSA","e":"{}","kid":"{A2_TEST_KID}"}}"#,
        field(&a2["jwk"], "e")
    )
    .into_bytes();

    let err = PinnedKey::from_jwk(&json).expect_err("a JWK missing `n` must be rejected");
    assert_eq!(err, JwsError::BadPinnedKey);
}

#[test]
fn from_jwk_rejects_missing_e() {
    let a2 = a2_fixture();
    let json = format!(
        r#"{{"kty":"RSA","n":"{}","kid":"{A2_TEST_KID}"}}"#,
        field(&a2["jwk"], "n")
    )
    .into_bytes();

    let err = PinnedKey::from_jwk(&json).expect_err("a JWK missing `e` must be rejected");
    assert_eq!(err, JwsError::BadPinnedKey);
}

#[test]
fn from_jwk_rejects_missing_kid() {
    let a2 = a2_fixture();
    let json = format!(
        r#"{{"kty":"RSA","n":"{}","e":"{}"}}"#,
        field(&a2["jwk"], "n"),
        field(&a2["jwk"], "e")
    )
    .into_bytes();

    let err = PinnedKey::from_jwk(&json).expect_err("a JWK missing `kid` must be rejected");
    assert_eq!(err, JwsError::BadPinnedKey);
}

#[test]
fn from_jwk_rejects_non_base64url_n() {
    let a2 = a2_fixture();
    let json = pinned_jwk_json("not-valid-base64url!!", field(&a2["jwk"], "e"), A2_TEST_KID);

    let err = PinnedKey::from_jwk(&json).expect_err("invalid base64url `n` must be rejected");
    assert_eq!(err, JwsError::BadPinnedKey);
}

#[test]
fn from_jwk_rejects_keys_under_2048_bits() {
    // A real (if tiny) RSA key generated at test time, seeded for a
    // deterministic, fast test: RFC 7515/7520 only publish 2048-bit keys.
    let mut rng = ChaCha20Rng::seed_from_u64(1024);
    let short_key = RsaPrivateKey::new(&mut rng, 1024).expect("1024-bit keygen");
    let (n_b64, e_b64) = public_components_b64(&short_key.to_public_key());
    let json = pinned_jwk_json(&n_b64, &e_b64, "short-key");

    let err = PinnedKey::from_jwk(&json).expect_err("a sub-2048-bit key must be rejected");
    assert_eq!(err, JwsError::BadPinnedKey);
}

#[test]
fn from_jwk_rejects_jwk_carrying_a_private_exponent() {
    let a2 = a2_fixture();
    let json = format!(
        r#"{{"kty":"RSA","n":"{}","e":"{}","d":"{}","kid":"{A2_TEST_KID}"}}"#,
        field(&a2["jwk"], "n"),
        field(&a2["jwk"], "e"),
        field(&a2["jwk"], "d"),
    )
    .into_bytes();

    let err = PinnedKey::from_jwk(&json).expect_err("a JWK carrying `d` must be rejected");
    assert_eq!(err, JwsError::BadPinnedKey);
}

// ---------------------------------------------------------------------
// verify_signature (pub(crate))
// ---------------------------------------------------------------------

#[test]
fn verify_signature_accepts_the_rfc7515_a2_golden_vector() {
    let a2 = a2_fixture();
    let pub_key = rsa_public_key_from_jwk(&a2["jwk"]);
    let signing_input = field(&a2, "signing_input").as_bytes();
    let signature = URL_SAFE_NO_PAD
        .decode(field(&a2, "signature_b64"))
        .expect("valid base64url");

    verify_signature(&pub_key, Alg::Rs256, signing_input, &signature)
        .expect("the RFC 7515 A.2 signature must verify");
}

#[test]
fn verify_signature_rejects_a_tampered_signing_input() {
    let a2 = a2_fixture();
    let pub_key = rsa_public_key_from_jwk(&a2["jwk"]);
    let signing_input = field(&a2, "signing_input").as_bytes();
    let signature = URL_SAFE_NO_PAD
        .decode(field(&a2, "signature_b64"))
        .expect("valid base64url");

    // Baseline: the untouched signing input verifies.
    assert!(verify_signature(&pub_key, Alg::Rs256, signing_input, &signature).is_ok());

    let mut tampered = signing_input.to_vec();
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01;

    let err = verify_signature(&pub_key, Alg::Rs256, &tampered, &signature)
        .expect_err("a tampered signing input must be rejected");
    assert_eq!(err, JwsError::BadSignature);
    assert_eq!(err.code(), "bad_signature");
}

#[test]
fn verify_signature_rejects_a_signature_of_the_wrong_length() {
    let a2 = a2_fixture();
    let pub_key = rsa_public_key_from_jwk(&a2["jwk"]);
    let signing_input = field(&a2, "signing_input").as_bytes();
    let mut signature = URL_SAFE_NO_PAD
        .decode(field(&a2, "signature_b64"))
        .expect("valid base64url");

    // Baseline: the untouched signature verifies.
    assert!(verify_signature(&pub_key, Alg::Rs256, signing_input, &signature).is_ok());

    signature.pop();

    let err = verify_signature(&pub_key, Alg::Rs256, signing_input, &signature)
        .expect_err("a signature shorter than the modulus must be rejected");
    assert_eq!(err, JwsError::BadSignature);
}

#[test]
fn verify_signature_accepts_a_genuine_rs512_signature() {
    let a2 = a2_fixture();
    let priv_key = rsa_private_key_from_jwk(&a2["jwk"]);
    let pub_key = priv_key.to_public_key();
    let message = b"rs512 detached body, signed with a 2048-bit key";
    let signature = SigningKey::<Sha512>::new(priv_key).sign(message).to_vec();

    verify_signature(&pub_key, Alg::Rs512, message, &signature)
        .expect("a genuine RS512 signature over a 2048-bit key must verify");
}

// ---------------------------------------------------------------------
// sign_rs256 (pub(crate), shared with the RFC golden test)
// ---------------------------------------------------------------------

#[test]
fn sign_rs256_reproduces_the_rfc7515_a2_signature_byte_for_byte() {
    let a2 = a2_fixture();
    let priv_key = rsa_private_key_from_jwk(&a2["jwk"]);
    let signing_input = field(&a2, "signing_input").as_bytes();
    let expected = URL_SAFE_NO_PAD
        .decode(field(&a2, "signature_b64"))
        .expect("valid base64url");

    let mut rng = ChaCha20Rng::seed_from_u64(7);
    let signature = sign_rs256(&priv_key, signing_input, &mut rng)
        .expect("signing with the RFC key must succeed");

    // PKCS#1 v1.5 padding is deterministic: blinding changes only the
    // intermediate computation, not the final signature bytes.
    assert_eq!(signature, expected);
}

#[test]
fn sign_rs256_output_verifies_against_the_matching_public_key() {
    let a2 = a2_fixture();
    let priv_key = rsa_private_key_from_jwk(&a2["jwk"]);
    let pub_key = priv_key.to_public_key();
    let signing_input = b"an arbitrary message, not the golden vector";

    let mut rng = ChaCha20Rng::seed_from_u64(9);
    let signature = sign_rs256(&priv_key, signing_input, &mut rng).expect("signing must succeed");

    verify_signature(&pub_key, Alg::Rs256, signing_input, &signature)
        .expect("our own freshly produced signature must verify");
}

// ---------------------------------------------------------------------
// FiuSigningKey::generate (one test only: RSA-2048 keygen is slow in debug)
// ---------------------------------------------------------------------

#[test]
fn generate_produces_a_2048_bit_key_that_signs_a_verifiable_detached_jws() {
    let mut rng = ChaCha20Rng::seed_from_u64(2048);
    let signing = FiuSigningKey::generate("test-fiu-key".to_owned(), &mut rng)
        .expect("RSA-2048 keygen must succeed");

    assert_eq!(signing.kid(), "test-fiu-key");
    assert_eq!(PublicKeyParts::n(signing.key()).bits(), 2048);

    let body = b"POST /FI/request body bytes";
    let jws = signing
        .sign_detached(body, &mut rng)
        .expect("signing with the generated key must succeed");

    let (n_b64, e_b64) = public_components_b64(&signing.key().to_public_key());
    let pinned = PinnedKey::from_jwk(&pinned_jwk_json(&n_b64, &e_b64, "test-fiu-key"))
        .expect("the generated key's public half must pin");

    verify_detached(&jws, body, &[pinned])
        .expect("a freshly generated key must produce a JWS that verifies");
}

#[test]
fn from_jwk_rejects_jwk_carrying_private_members_without_d() {
    let a2 = a2_fixture();
    for member in ["p", "q", "dp", "dq", "qi", "oth"] {
        let json = format!(
            r#"{{"kty":"RSA","n":"{}","e":"{}","kid":"{A2_TEST_KID}","{member}":"AQAB"}}"#,
            field(&a2["jwk"], "n"),
            field(&a2["jwk"], "e"),
        )
        .into_bytes();

        let err = PinnedKey::from_jwk(&json)
            .expect_err(&format!("a JWK carrying `{member}` must be rejected"));
        assert_eq!(err, JwsError::BadPinnedKey, "member {member}");
    }
}

#[test]
fn from_jwk_rejects_a_json_array() {
    let a2 = a2_fixture();
    let json = format!(
        r#"["RSA","{}","{}","{A2_TEST_KID}"]"#,
        field(&a2["jwk"], "n"),
        field(&a2["jwk"], "e"),
    )
    .into_bytes();

    let err = PinnedKey::from_jwk(&json).expect_err("a JWK must be a JSON object");
    assert_eq!(err, JwsError::BadPinnedKey);
}

#[test]
fn from_jwk_rejects_non_minimal_n_or_e() {
    let a2 = a2_fixture();
    let n = field(&a2["jwk"], "n");
    let e = field(&a2["jwk"], "e");

    // Baseline: the minimal encodings pin.
    assert!(PinnedKey::from_jwk(&pinned_jwk_json(n, e, A2_TEST_KID)).is_ok());

    // Same integers with one leading zero octet: RFC 7518 §2 forbids it.
    let padded = |b64: &str| {
        let mut bytes = URL_SAFE_NO_PAD.decode(b64).unwrap();
        bytes.insert(0, 0);
        URL_SAFE_NO_PAD.encode(bytes)
    };
    for json in [
        pinned_jwk_json(&padded(n), e, A2_TEST_KID),
        pinned_jwk_json(n, &padded(e), A2_TEST_KID),
        pinned_jwk_json(n, "", A2_TEST_KID),
    ] {
        let err = PinnedKey::from_jwk(&json).expect_err("non-minimal n/e must be rejected");
        assert_eq!(err, JwsError::BadPinnedKey);
    }
}
