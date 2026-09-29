#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use base64::Engine as _;
use serde_json::Value;

use super::*;
use crate::ErrorCode;

fn ecc_vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../../test-vectors/golden/rahasya/ecc.json"
    ))
    .expect("ecc.json is valid JSON")
}

fn hex32(s: &str) -> [u8; 32] {
    hex::decode(s)
        .expect("valid hex")
        .try_into()
        .expect("32 bytes")
}

/// The `basic` vector's FIP public key, bare DER (309 bytes).
fn sample_der() -> Vec<u8> {
    let vectors = ecc_vectors();
    let pem = vectors["vectors"][0]["fip"]["key_material"]["DHPublicKey"]["KeyValue"]
        .as_str()
        .expect("string");
    let b64 = pem
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "");
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64")
}

/// Builds a wei25519 SPKI from the real 245-byte prefix plus a chosen point.
fn spki_with_point(x_be: &[u8; 32], y_be: &[u8; 32]) -> Vec<u8> {
    let mut der = sample_der()[..245].to_vec();
    der.extend_from_slice(x_be);
    der.extend_from_slice(y_be);
    der
}

#[test]
fn encode_spki_output_is_309_bytes_with_the_rahasya_prefix() {
    // Every wei25519 key shares the same 245-byte OID + explicit-params
    // prefix (curve, generator, order, cofactor); only the trailing 64-byte
    // point varies per key.
    let vectors = ecc_vectors();
    let u = MontgomeryPoint(hex32(
        vectors["vectors"][0]["fip"]["public_montgomery_u_le_hex"]
            .as_str()
            .expect("string"),
    ));
    let der = encode_spki(&u).expect("a valid u encodes");
    assert_eq!(der.len(), 309);
    assert_eq!(der[..245], sample_der()[..245]);
}

#[test]
fn parse_spki_extracts_expected_montgomery_u() {
    let vectors = ecc_vectors();
    let der = sample_der();
    let expected = MontgomeryPoint(hex32(
        vectors["vectors"][0]["fip"]["public_montgomery_u_le_hex"]
            .as_str()
            .expect("string"),
    ));
    let u = parse_spki(&der).expect("valid wei25519 spki");
    assert_eq!(u, expected);
}

#[test]
fn encode_then_parse_round_trips() {
    let vectors = ecc_vectors();
    let expected = MontgomeryPoint(hex32(
        vectors["vectors"][0]["fip"]["public_montgomery_u_le_hex"]
            .as_str()
            .expect("string"),
    ));
    let der = encode_spki(&expected).expect("a valid u encodes");
    let parsed = parse_spki(&der).expect("the encoded key round-trips");
    assert_eq!(parsed, expected);
}

#[test]
fn parses_order_two_point_to_montgomery_u_zero() {
    // The order-2 point of the Montgomery curve (u = 0) maps to Weierstrass
    // x_W = A/3, y_W = 0 (`docs/FORMATS.md` §3). It is a legitimate on-curve
    // point: parsing must succeed. Rejecting it happens later, when the
    // resulting zero shared secret is checked (`ecdh::finish_shared`).
    let vectors = ecc_vectors();
    let a_over_3 = hex32(vectors["curve"]["a_over_3_hex"].as_str().expect("string"));
    let der = spki_with_point(&a_over_3, &[0u8; 32]);
    let u = parse_spki(&der).expect("the order-2 point is on the curve");
    assert_eq!(u, MontgomeryPoint([0u8; 32]));
}

#[test]
fn rejects_spki_with_altered_curve_param() {
    let mut der = sample_der();
    assert!(
        parse_spki(&der).is_ok(),
        "baseline: the untouched key must parse"
    );

    // Flip one byte inside curve parameter `b` (DER offset 105..137; see
    // ecc.json `curve.b_hex`, verified against the decoded SPKI bytes).
    der[106] ^= 0x01;
    let err = parse_spki(&der).expect_err("an altered curve parameter must be rejected");
    assert_eq!(err, KeyError::UnsupportedKey);
    assert_eq!(err.code(), "bad_key_material");
}

#[test]
fn rejects_off_curve_point() {
    let mut der = sample_der();
    assert!(
        parse_spki(&der).is_ok(),
        "baseline: the untouched point must be on curve"
    );

    // Bump the last byte of Y by one: still < p, essentially certainly off
    // the curve.
    let last = der.len() - 1;
    der[last] = der[last].wrapping_add(1);
    let err = parse_spki(&der).expect_err("an off-curve point must be rejected");
    assert_eq!(err, KeyError::InvalidPoint);
    assert_eq!(err.code(), "invalid_point");
}

#[test]
fn rejects_coordinate_not_below_p() {
    let mut der = sample_der();
    assert!(
        parse_spki(&der).is_ok(),
        "baseline: the untouched point must parse"
    );

    // Set X to 32 bytes of 0xFF: as a big-endian integer this is far above
    // p = 2^255 - 19.
    let x_start = 245;
    for b in &mut der[x_start..x_start + 32] {
        *b = 0xFF;
    }
    let err = parse_spki(&der).expect_err("a coordinate >= p must be rejected");
    assert_eq!(err, KeyError::InvalidPoint);
    assert_eq!(err.code(), "invalid_point");
}

/// Big-endian `n + p` for a coordinate `n < p`. Still fits in 32 bytes,
/// since p < 2^255.
fn plus_p(n_be: &[u8]) -> [u8; 32] {
    let p = hex32("7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let sum = u16::from(n_be[i]) + u16::from(p[i]) + carry;
        out[i] = (sum & 0xff) as u8;
        carry = sum >> 8;
    }
    assert_eq!(carry, 0, "n + p must fit in 32 bytes");
    out
}

#[test]
fn rejects_non_canonical_coordinate_encoding() {
    // x + p (or y + p) names the same field element as the real on-curve
    // coordinate, so only the explicit range check can catch it: the
    // on-curve check alone would accept the silently reduced value.
    let der = sample_der();
    assert!(
        parse_spki(&der).is_ok(),
        "baseline: the untouched point must parse"
    );
    let (x, y) = (&der[245..277], &der[277..309]);

    for (label, spki) in [
        ("x + p", spki_with_point(&plus_p(x), &y.try_into().unwrap())),
        ("y + p", spki_with_point(&x.try_into().unwrap(), &plus_p(y))),
    ] {
        let err = parse_spki(&spki).expect_err(label);
        assert_eq!(err, KeyError::InvalidPoint, "{label}");
        assert_eq!(err.code(), "invalid_point");
    }
}
