#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use base64::Engine as _;
use curve25519_dalek::montgomery::MontgomeryPoint;
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde_json::Value;

use super::*;
use crate::ecdh::{KeyMode, SessionKeyPair};

fn ecc_vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../test-vectors/golden/rahasya/ecc.json"
    ))
    .expect("ecc.json is valid JSON")
}

fn hex32(s: &str) -> [u8; 32] {
    hex::decode(s)
        .expect("valid hex")
        .try_into()
        .expect("32 bytes")
}

// ---------------------------------------------------------------------
// Golden: rahasya's exact JSON shape
// ---------------------------------------------------------------------

#[test]
fn parses_rahasya_key_material_json() {
    let vectors = ecc_vectors();
    let v = &vectors["vectors"][0];

    // ecc.json stores the nonce alongside the vector, not inside
    // `key_material`; graft it on to get rahasya's exact wire shape.
    let mut key_material = v["fip"]["key_material"].clone();
    key_material["Nonce"] = v["fip_nonce_b64"].clone();

    // rahasya's own JSON: `Parameter` singular, lowercase `curve25519`.
    let key_material_json = serde_json::to_string(&key_material).expect("serializable");
    let km: KeyMaterial =
        serde_json::from_str(&key_material_json).expect("rahasya's shape must parse");

    assert_eq!(km.curve.as_deref(), Some("curve25519"));
    assert_eq!(km.dh_public_key.parameters.as_deref(), Some(""));

    let peer = km
        .peer_public_key()
        .expect("a valid rahasya key must parse");
    let expected_u = MontgomeryPoint(hex32(
        v["fip"]["public_montgomery_u_le_hex"]
            .as_str()
            .expect("string"),
    ));
    assert_eq!(*peer.montgomery_u(), expected_u);

    let nonce = km.nonce().expect("a valid nonce must parse");
    let expected_nonce =
        Nonce::from_base64(v["fip_nonce_b64"].as_str().expect("string")).expect("valid nonce");
    assert_eq!(nonce, expected_nonce);
}

#[test]
fn accepts_cryptoalg_null_and_shuffled_labels() {
    let vectors = ecc_vectors();
    let v = &vectors["vectors"][0];
    let key_value = v["fip"]["key_material"]["DHPublicKey"]["KeyValue"]
        .as_str()
        .expect("string");
    let nonce_b64 = v["fip_nonce_b64"].as_str().expect("string");

    // Finvu's own fetch-response sample shuffles the labels this way
    // (`docs/FORMATS.md` §3, §12): the key type must come from `KeyValue` alone.
    let json = format!(
        r#"{{"cryptoAlg":null,"curve":"ECDH","params":"Curve25519","DHPublicKey":{{"expiry":"2026-09-27T11:33:53.170Z","Parameters":"","KeyValue":"{key_value}"}},"Nonce":"{nonce_b64}"}}"#
    );
    let km: KeyMaterial = serde_json::from_str(&json).expect("shuffled labels must still parse");
    assert!(km.crypto_alg.is_none());
    assert!(km.peer_public_key().is_ok());
    assert!(km.nonce().is_ok());
}

// ---------------------------------------------------------------------
// Own output
// ---------------------------------------------------------------------

#[test]
fn key_material_new_emits_single_line_pem_and_parameters_label() {
    let mut rng = ChaCha20Rng::seed_from_u64(7);
    let keypair = SessionKeyPair::generate(KeyMode::Wei25519, &mut rng);
    let nonce = Nonce::random(&mut rng);
    let expiry_unix: i64 = 1_790_416_800; // 2026-09-26T10:00:00.000Z

    let km =
        KeyMaterial::new(keypair.public_key(), &nonce, expiry_unix).expect("a valid key encodes");

    assert_eq!(km.crypto_alg.as_deref(), Some("ECDH"));
    assert_eq!(km.curve.as_deref(), Some("Curve25519"));
    assert_eq!(km.params.as_deref(), Some(""));
    assert_eq!(km.dh_public_key.parameters.as_deref(), Some(""));
    assert_eq!(
        km.dh_public_key.expiry,
        crate::time::format_iso_utc(expiry_unix)
    );

    // rahasya rejects a line-wrapped PEM: we must emit the single-line form.
    assert!(!km.dh_public_key.key_value.contains('\n'));
    assert!(!km.dh_public_key.key_value.contains('\r'));
    assert!(km
        .dh_public_key
        .key_value
        .starts_with("-----BEGIN PUBLIC KEY-----"));
    assert!(km
        .dh_public_key
        .key_value
        .ends_with("-----END PUBLIC KEY-----"));

    // The wire key is `Parameters`, never rahasya's input-only `Parameter`.
    let json = serde_json::to_string(&km).expect("serializable");
    assert!(json.contains("\"Parameters\""));
    assert!(!json.contains("\"Parameter\":"));
}

// ---------------------------------------------------------------------
// Negatives
// ---------------------------------------------------------------------

#[test]
fn rejects_bad_key_value_encoding() {
    let km = KeyMaterial {
        crypto_alg: Some("ECDH".to_owned()),
        curve: Some("Curve25519".to_owned()),
        params: Some(String::new()),
        dh_public_key: DhPublicKey {
            expiry: "2026-09-26T10:00:00.000Z".to_owned(),
            parameters: Some(String::new()),
            key_value: "-----BEGIN PUBLIC KEY-----not-valid-base64!!-----END PUBLIC KEY-----"
                .to_owned(),
        },
        nonce: "AAAA".to_owned(),
    };
    let err = km
        .peer_public_key()
        .expect_err("bad base64 must be rejected");
    assert_eq!(err, KeyMaterialError::BadEncoding);
    assert_eq!(err.code(), "bad_key_material");
}

#[test]
fn rejects_bad_nonce_encoding() {
    let vectors = ecc_vectors();
    let key_value = vectors["vectors"][0]["fip"]["key_material"]["DHPublicKey"]["KeyValue"]
        .as_str()
        .expect("string")
        .to_owned();
    let km = KeyMaterial {
        crypto_alg: Some("ECDH".to_owned()),
        curve: Some("Curve25519".to_owned()),
        params: Some(String::new()),
        dh_public_key: DhPublicKey {
            expiry: "2026-09-26T10:00:00.000Z".to_owned(),
            parameters: Some(String::new()),
            key_value,
        },
        // 31 bytes, not the required 32.
        nonce: base64::engine::general_purpose::STANDARD.encode([0u8; 31]),
    };
    let err = km
        .nonce()
        .expect_err("a wrong-length nonce must be rejected");
    assert_eq!(err, KeyMaterialError::Decrypt(DecryptError::BadNonce));
    // `Decrypt(e)` delegates to `e.code()`, not the generic key-material code.
    assert_eq!(err.code(), "bad_nonce");
}

#[test]
fn key_material_error_codes_match_spec() {
    assert_eq!(KeyMaterialError::BadEncoding.code(), "bad_key_material");
    assert_eq!(
        KeyMaterialError::Key(KeyError::UnsupportedKey).code(),
        "bad_key_material"
    );
    assert_eq!(
        KeyMaterialError::Decrypt(DecryptError::DecryptFailed).code(),
        "decrypt_failed"
    );
}
