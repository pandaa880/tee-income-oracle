#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use tio_core::jws::{verify_compact, verify_detached, PinnedKey};
use tio_core::ErrorCode;

#[derive(Deserialize)]
struct TestCase {
    name: String,
    expect: String,
    form: String,
    jws: String,
    #[serde(default)]
    #[serde(rename = "bodyB64")]
    body_b64: String,
}

#[test]
fn test_node_vectors() {
    let vectors_json = include_str!("../../test-vectors/crosscheck/node_vectors.json");
    let cases: Vec<TestCase> = serde_json::from_str(vectors_json).expect("parse node vectors");

    let a2_json = include_str!("../../test-vectors/golden/rfc7515/a2.json");
    let a2_val: serde_json::Value = serde_json::from_str(a2_json).unwrap();
    let a2_jwk_val = serde_json::json!({
        "kty": a2_val["jwk"]["kty"],
        "n": a2_val["jwk"]["n"],
        "e": a2_val["jwk"]["e"],
        "kid": "11111111-1111-4111-8111-111111111111"
    });
    let a2_key =
        PinnedKey::from_jwk(&serde_json::to_vec(&a2_jwk_val).unwrap()).expect("parse a2 key");

    let rfc7520_json = include_str!("../../test-vectors/golden/rfc7515/rfc7520.json");
    let rfc7520_val: serde_json::Value = serde_json::from_str(rfc7520_json).unwrap();
    let rfc7520_jwk_val = serde_json::json!({
        "kty": rfc7520_val["jwk"]["kty"],
        "n": rfc7520_val["jwk"]["n"],
        "e": rfc7520_val["jwk"]["e"],
        "kid": rfc7520_val["jwk"]["kid"]
    });
    let _rfc7520_key = PinnedKey::from_jwk(&serde_json::to_vec(&rfc7520_jwk_val).unwrap())
        .expect("parse rfc7520 key");

    let pinned_keys = vec![a2_key];

    assert!(cases.len() >= 15, "need >= 15 cases");

    let mut ok_count = 0;

    for case in cases {
        let result = if case.form == "detached" {
            let body = URL_SAFE_NO_PAD
                .decode(&case.body_b64)
                .expect("decode bodyB64");
            verify_detached(&case.jws, &body, &pinned_keys).map(|_| ())
        } else {
            verify_compact(&case.jws, &pinned_keys).map(|_| ())
        };

        match result {
            Ok(_) => {
                assert_eq!(
                    case.expect, "ok",
                    "case '{}' expected {} but was ok",
                    case.name, case.expect
                );
                ok_count += 1;
            }
            Err(e) => {
                assert_eq!(
                    case.expect,
                    e.code(),
                    "case '{}' expected {} but got {}",
                    case.name,
                    case.expect,
                    e.code()
                );
            }
        }
    }

    assert!(ok_count >= 4, "need at least 4 ok cases");
}
