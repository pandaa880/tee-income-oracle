#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use base64::Engine as _;
use curve25519_dalek::scalar::Scalar;
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde_json::Value;

use super::*;
use crate::ErrorCode;

// ---------------------------------------------------------------------
// Vector loading helpers (test-only; keep each tests.rs's loader small).
// ---------------------------------------------------------------------

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

/// Strips PEM armour and base64-decodes, independent of `crate::encoding`
/// (which has its own dedicated tests) so this module can run standalone.
fn pem_to_bare_der(pem: &str) -> Vec<u8> {
    let b64 = pem
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "");
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64")
}

/// The SPKI DER of the `basic` vector's FIP key: a real 309-byte wei25519
/// template, reused to build tampered / synthetic points.
fn sample_wei25519_der() -> Vec<u8> {
    let vectors = ecc_vectors();
    pem_to_bare_der(
        vectors["vectors"][0]["fip"]["key_material"]["DHPublicKey"]["KeyValue"]
            .as_str()
            .expect("string"),
    )
}

/// Builds a wei25519 SPKI from the real 245-byte prefix plus a chosen point.
fn wei25519_spki_with_point(x_be: &[u8; 32], y_be: &[u8; 32]) -> Vec<u8> {
    let mut der = sample_wei25519_der()[..245].to_vec();
    der.extend_from_slice(x_be);
    der.extend_from_slice(y_be);
    der
}

/// Builds a 44-byte X25519 SPKI (`docs/FORMATS.md` §3) from a raw u.
fn x25519_spki_der(u_le: &[u8; 32]) -> Vec<u8> {
    let mut der = hex::decode("302a300506032b656e032100").expect("valid hex");
    der.extend_from_slice(u_le);
    der
}

// ---------------------------------------------------------------------
// Golden vectors
// ---------------------------------------------------------------------

#[test]
fn parses_rahasya_spki_to_expected_montgomery_u() {
    let vectors = ecc_vectors();
    for v in vectors["vectors"].as_array().expect("array") {
        for role in ["fip", "fiu"] {
            let key_value = v[role]["key_material"]["DHPublicKey"]["KeyValue"]
                .as_str()
                .expect("string");
            let der = pem_to_bare_der(key_value);
            let peer = PeerPublicKey::from_spki_der(&der).expect("valid wei25519 spki");
            assert_eq!(peer.mode(), KeyMode::Wei25519);

            let expected_u = MontgomeryPoint(hex32(
                v[role]["public_montgomery_u_le_hex"]
                    .as_str()
                    .expect("string"),
            ));
            assert_eq!(
                *peer.montgomery_u(),
                expected_u,
                "{role} in vector {}",
                v["name"]
            );
        }
    }
}

#[test]
fn reproduces_rahasya_shared_secret_from_unclamped_scalar() {
    // Covers both `basic` and `shared_secret_leading_zero`.
    let vectors = ecc_vectors();
    for v in vectors["vectors"].as_array().expect("array") {
        let fiu_d_le = hex32(v["fiu"]["scalar_d_le_hex"].as_str().expect("string"));
        let fip_u = MontgomeryPoint(hex32(
            v["fip"]["public_montgomery_u_le_hex"]
                .as_str()
                .expect("string"),
        ));

        // BC's scalar is NOT clamped: reproduce it with test-only raw scalar
        // math (`docs/FORMATS.md` §3), not `mul_clamped`.
        let s = Scalar::from_bytes_mod_order(fiu_d_le) * fip_u;
        let shared = finish_shared(KeyMode::Wei25519, &s).expect("nonzero shared secret");

        let expected = hex32(v["shared_secret_hex"].as_str().expect("string"));
        assert_eq!(*shared.as_bytes(), expected, "vector {}", v["name"]);
    }
}

#[test]
fn reproduces_x25519_vector_shared_secret() {
    let v = x25519_vector();
    let fip_priv = hex32(v["fip"]["private_key_raw_hex"].as_str().expect("string"));
    let fiu_pub = MontgomeryPoint(hex32(
        v["fiu"]["public_key_raw_hex"].as_str().expect("string"),
    ));

    // x25519.json keys are standard RFC 7748: clamped multiplication is correct here.
    let s = fiu_pub.mul_clamped(fip_priv);
    let shared = finish_shared(KeyMode::X25519, &s).expect("nonzero shared secret");

    let expected = hex32(v["shared_secret_hex"].as_str().expect("string"));
    assert_eq!(*shared.as_bytes(), expected);
}

// ---------------------------------------------------------------------
// Own keys
// ---------------------------------------------------------------------

#[test]
fn generated_wei25519_spki_is_309_bytes_with_rahasya_prefix() {
    let mut rng = ChaCha20Rng::seed_from_u64(1);
    let keypair = SessionKeyPair::generate(KeyMode::Wei25519, &mut rng);
    let der = keypair
        .public_key()
        .to_spki_der()
        .expect("a freshly generated key always has a Weierstrass y");
    assert_eq!(der.len(), 309);

    // Every wei25519 key shares the same 245-byte OID + explicit-params
    // prefix; only the trailing 64-byte point differs.
    let sample = sample_wei25519_der();
    assert_eq!(der[..245], sample[..245]);

    let b64 = base64::engine::general_purpose::STANDARD.encode(&der);
    assert!(b64.starts_with("MIIBMTCB6gYHKoZIzj0CAT"));
}

#[test]
fn generated_key_round_trips_through_spki() {
    for mode in [KeyMode::Wei25519, KeyMode::X25519] {
        let mut rng = ChaCha20Rng::seed_from_u64(2);
        let keypair = SessionKeyPair::generate(mode, &mut rng);
        let der = keypair
            .public_key()
            .to_spki_der()
            .expect("valid key encodes");

        let peer = PeerPublicKey::from_spki_der(&der).expect("our own key round-trips");
        assert_eq!(peer.mode(), mode);
        assert_eq!(peer.montgomery_u(), keypair.public_key().montgomery_u());
    }
}

#[test]
fn two_session_keys_agree_on_shared_secret() {
    for mode in [KeyMode::Wei25519, KeyMode::X25519] {
        let mut rng_a = ChaCha20Rng::seed_from_u64(10);
        let mut rng_b = ChaCha20Rng::seed_from_u64(11);
        let a = SessionKeyPair::generate(mode, &mut rng_a);
        let b = SessionKeyPair::generate(mode, &mut rng_b);

        let a_der = a.public_key().to_spki_der().expect("valid key");
        let b_der = b.public_key().to_spki_der().expect("valid key");
        let peer_of_b = PeerPublicKey::from_spki_der(&b_der).expect("valid peer");
        let peer_of_a = PeerPublicKey::from_spki_der(&a_der).expect("valid peer");

        let shared_a = a.shared_secret(&peer_of_b).expect("A agrees with B");
        let shared_b = b.shared_secret(&peer_of_a).expect("B agrees with A");
        assert_eq!(shared_a.as_bytes(), shared_b.as_bytes());
    }
}

// ---------------------------------------------------------------------
// Negatives
// ---------------------------------------------------------------------

#[test]
fn rejects_mode_mismatch() {
    let mut rng_a = ChaCha20Rng::seed_from_u64(20);
    let mut rng_b = ChaCha20Rng::seed_from_u64(21);
    let ours = SessionKeyPair::generate(KeyMode::Wei25519, &mut rng_a);
    let other = SessionKeyPair::generate(KeyMode::X25519, &mut rng_b);

    let peer_der = other.public_key().to_spki_der().expect("valid key");
    let peer = PeerPublicKey::from_spki_der(&peer_der).expect("valid x25519 peer");

    // `SharedSecret` isn't `Debug`, so map the `Ok` away before `expect_err`.
    let err = ours
        .shared_secret(&peer)
        .map(|_| ())
        .expect_err("our wei25519 key must reject an x25519 peer");
    assert_eq!(err, KeyError::ModeMismatch);
    assert_eq!(err.code(), "bad_key_material");
}

#[test]
fn rejects_small_order_peer_point_x25519() {
    let mut rng = ChaCha20Rng::seed_from_u64(30);
    let ours = SessionKeyPair::generate(KeyMode::X25519, &mut rng);

    let mut u_one = [0u8; 32];
    u_one[0] = 1;
    for u in [[0u8; 32], u_one] {
        let der = x25519_spki_der(&u);
        let peer = PeerPublicKey::from_spki_der(&der).expect("small-order point still parses");

        let err = ours
            .shared_secret(&peer)
            .map(|_| ())
            .expect_err("small-order x25519 point must be rejected");
        assert_eq!(err, KeyError::InvalidPoint);
        assert_eq!(err.code(), "invalid_point");
    }
}

#[test]
fn rejects_small_order_peer_point_wei25519() {
    // The order-2 point of the Montgomery curve (u = 0) maps to Weierstrass
    // x_W = A/3, y_W = 0 (`docs/FORMATS.md` §3).
    let vectors = ecc_vectors();
    let a_over_3 = hex32(vectors["curve"]["a_over_3_hex"].as_str().expect("string"));
    let der = wei25519_spki_with_point(&a_over_3, &[0u8; 32]);
    let peer = PeerPublicKey::from_spki_der(&der).expect("the order-2 point is on the curve");

    let mut rng = ChaCha20Rng::seed_from_u64(31);
    let ours = SessionKeyPair::generate(KeyMode::Wei25519, &mut rng);

    let err = ours
        .shared_secret(&peer)
        .map(|_| ())
        .expect_err("order-2 wei25519 point must be rejected");
    assert_eq!(err, KeyError::InvalidPoint);
    assert_eq!(err.code(), "invalid_point");
}

#[test]
fn rejects_unknown_spki() {
    // A P-256 SPKI (91 bytes): it doesn't start with the wei25519 prefix, so
    // it falls through to the x25519 parser, whose length check rejects it.
    let mut p256_spki =
        hex::decode("3059301306072a8648ce3d020106082a8648ce3d030107034200").expect("valid hex");
    p256_spki.extend_from_slice(&[0xAAu8; 65]);
    let err = PeerPublicKey::from_spki_der(&p256_spki)
        .map(|_| ())
        .expect_err("a P-256 key must be rejected");
    assert_eq!(err, KeyError::UnsupportedKey);
    assert_eq!(err.code(), "bad_key_material");

    // A wei25519 SPKI truncated by one byte (308 of the expected 309).
    let full = sample_wei25519_der();
    let truncated = &full[..full.len() - 1];
    let err = PeerPublicKey::from_spki_der(truncated)
        .map(|_| ())
        .expect_err("a truncated key must be rejected");
    assert_eq!(err, KeyError::UnsupportedKey);
    assert_eq!(err.code(), "bad_key_material");
}

#[test]
fn rejects_same_length_spki_with_wrong_x25519_oid() {
    // Ed25519 (OID 1.3.101.112) has the same 44-byte shape as X25519
    // (1.3.101.110), so only the prefix compare can tell them apart.
    let u = [0x09u8; 32];
    let mut x25519_spki = hex::decode("302a300506032b656e032100").expect("valid hex");
    x25519_spki.extend_from_slice(&u);
    let peer =
        PeerPublicKey::from_spki_der(&x25519_spki).expect("baseline: real X25519 prefix parses");
    assert_eq!(peer.mode(), KeyMode::X25519);

    let mut ed25519_spki = hex::decode("302a300506032b6570032100").expect("valid hex");
    ed25519_spki.extend_from_slice(&u);
    let err = PeerPublicKey::from_spki_der(&ed25519_spki)
        .map(|_| ())
        .expect_err("an Ed25519 key must be rejected");
    assert_eq!(err, KeyError::UnsupportedKey);
    assert_eq!(err.code(), "bad_key_material");
}

#[test]
fn rejects_order_four_wei25519_peer_point() {
    // Montgomery u = 1 is a point of order 4 on Curve25519 (A + 2 is a
    // square). Unlike u = 0, a non-multiple-of-4 scalar would NOT send it to
    // zero, so this proves our scalar is clamped on the wei25519 path.
    let der = wei25519::encode_spki(&MontgomeryPoint({
        let mut one = [0u8; 32];
        one[0] = 1;
        one
    }))
    .expect("u = 1 is on the curve");
    let peer = PeerPublicKey::from_spki_der(&der).expect("an on-curve point parses");

    let mut rng = ChaCha20Rng::seed_from_u64(47);
    let ours = SessionKeyPair::generate(KeyMode::Wei25519, &mut rng);
    let err = ours
        .shared_secret(&peer)
        .map(|_| ())
        .expect_err("order-4 wei25519 point must be rejected");
    assert_eq!(err, KeyError::InvalidPoint);
    assert_eq!(err.code(), "invalid_point");
}

#[test]
fn key_error_codes_match_spec() {
    assert_eq!(KeyError::UnsupportedKey.code(), "bad_key_material");
    assert_eq!(KeyError::ModeMismatch.code(), "bad_key_material");
    assert_eq!(KeyError::InvalidPoint.code(), "invalid_point");
}
