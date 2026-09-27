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
use rsa::{pkcs1v15::SigningKey, BigUint, RsaPrivateKey};
use serde_json::Value;
use sha2::{Sha256, Sha512};

use super::*;

// A test-only `kid` for the RFC 7515 A.2 key: its JWK has no `kid` of its
// own (`docs/FORMATS.md` §4 requires one), so pinning it needs one made up
// here, never edited into the fixture.
const A2_TEST_KID: &str = "11111111-1111-4111-8111-111111111111";

#[derive(Clone, Copy)]
enum TestAlg {
    Rs256,
    Rs512,
}

fn a2_fixture() -> Value {
    serde_json::from_str(include_str!("../../../test-vectors/golden/rfc7515/a2.json"))
        .expect("a2.json is valid JSON")
}

fn rfc7520_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../test-vectors/golden/rfc7515/rfc7520.json"
    ))
    .expect("rfc7520.json is valid JSON")
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

fn private_key_from_jwk(jwk: &Value) -> RsaPrivateKey {
    RsaPrivateKey::from_components(
        biguint(jwk, "n"),
        biguint(jwk, "e"),
        biguint(jwk, "d"),
        vec![biguint(jwk, "p"), biguint(jwk, "q")],
    )
    .expect("a valid RFC RSA key")
}

fn a2_private_key() -> RsaPrivateKey {
    private_key_from_jwk(&a2_fixture()["jwk"])
}

fn rfc7520_private_key() -> RsaPrivateKey {
    private_key_from_jwk(&rfc7520_fixture()["jwk"])
}

fn rfc7520_kid() -> String {
    field(&rfc7520_fixture()["jwk"], "kid").to_owned()
}

fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Builds the bytes of a public RSA JWK `{kty,n,e,kid}`, the shape
/// `PinnedKey::from_jwk` accepts (`docs/FORMATS.md` §4).
fn pinned_jwk_json(n_b64: &str, e_b64: &str, kid: &str) -> Vec<u8> {
    format!(r#"{{"kty":"RSA","n":"{n_b64}","e":"{e_b64}","kid":"{kid}"}}"#).into_bytes()
}

fn a2_pinned_key() -> PinnedKey {
    let a2 = a2_fixture();
    let json = pinned_jwk_json(field(&a2["jwk"], "n"), field(&a2["jwk"], "e"), A2_TEST_KID);
    PinnedKey::from_jwk(&json).expect("a valid a2 pinned key")
}

fn sign_raw(alg: TestAlg, priv_key: &RsaPrivateKey, msg: &[u8]) -> Vec<u8> {
    match alg {
        TestAlg::Rs256 => SigningKey::<Sha256>::new(priv_key.clone())
            .sign(msg)
            .to_vec(),
        TestAlg::Rs512 => SigningKey::<Sha512>::new(priv_key.clone())
            .sign(msg)
            .to_vec(),
    }
}

/// Assembles a detached (RFC 7797) JWS: `header..signature` over
/// `header_b64 || "." || body`.
fn make_detached_jws(
    header_json: &str,
    body: &[u8],
    priv_key: &RsaPrivateKey,
    alg: TestAlg,
) -> String {
    let header_b64 = b64u(header_json.as_bytes());
    let mut signing_input = format!("{header_b64}.").into_bytes();
    signing_input.extend_from_slice(body);
    let sig = sign_raw(alg, priv_key, &signing_input);
    format!("{header_b64}..{}", b64u(&sig))
}

/// Assembles a compact JWS: `header.payload.signature`.
fn make_compact_jws(
    header_json: &str,
    payload: &[u8],
    priv_key: &RsaPrivateKey,
    alg: TestAlg,
) -> String {
    let header_b64 = b64u(header_json.as_bytes());
    let payload_b64 = b64u(payload);
    let signing_input = format!("{header_b64}.{payload_b64}");
    let sig = sign_raw(alg, priv_key, signing_input.as_bytes());
    format!("{header_b64}.{payload_b64}.{}", b64u(&sig))
}

fn detached_header(kid: &str) -> String {
    format!(r#"{{"alg":"RS256","kid":"{kid}","b64":false,"crit":["b64"]}}"#)
}

fn compact_header(kid: &str) -> String {
    format!(r#"{{"alg":"RS256","kid":"{kid}"}}"#)
}

fn split_three(jws: &str) -> (&str, &str, &str) {
    let mut parts = jws.splitn(3, '.');
    let header = parts.next().expect("header segment");
    let middle = parts.next().expect("middle segment");
    let sig = parts.next().expect("signature segment");
    (header, middle, sig)
}

// ---------------------------------------------------------------------
// Golden (RFC 7515 Appendix A.2)
// ---------------------------------------------------------------------

#[test]
fn verify_compact_rejects_the_rfc7515_a2_jws_for_missing_kid() {
    let a2 = a2_fixture();
    let jws = field(&a2, "compact_jws");

    // Our policy is stricter than the bare RFC example: `kid` is required
    // (`docs/FORMATS.md` §4), and A.2's header (`{"alg":"RS256"}`) has none.
    let err = verify_compact(jws, &[a2_pinned_key()])
        .expect_err("a kid-less header must be rejected under our stricter policy");
    assert_eq!(err, JwsError::BadHeader);
}

// ---------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------

#[test]
fn verify_detached_accepts_a_genuine_rs256_round_trip() {
    let signing = FiuSigningKey::from_private_key(A2_TEST_KID.to_owned(), a2_private_key());
    let mut rng = ChaCha20Rng::seed_from_u64(1);
    let body = b"raw FI request body bytes";

    let jws = signing
        .sign_detached(body, &mut rng)
        .expect("signing must succeed");

    verify_detached(&jws, body, &[a2_pinned_key()]).expect("a genuine detached JWS must verify");
}

#[test]
fn verify_detached_accepts_rs512() {
    let priv_key = a2_private_key();
    let header = format!(r#"{{"alg":"RS512","kid":"{A2_TEST_KID}","b64":false,"crit":["b64"]}}"#);
    let body = b"rs512 detached body";
    let jws = make_detached_jws(&header, body, &priv_key, TestAlg::Rs512);

    verify_detached(&jws, body, &[a2_pinned_key()])
        .expect("a genuine RS512 detached JWS must verify");
}

#[test]
fn verify_compact_returns_the_exact_payload_for_rs256() {
    let priv_key = a2_private_key();
    let header = compact_header(A2_TEST_KID);
    let payload: &[u8] = br#"{"consentId":"abc-123","status":"ACTIVE"}"#;
    let jws = make_compact_jws(&header, payload, &priv_key, TestAlg::Rs256);

    let decoded =
        verify_compact(&jws, &[a2_pinned_key()]).expect("a genuine compact JWS must verify");
    assert_eq!(decoded, payload);
}

#[test]
fn verify_compact_returns_the_exact_payload_for_rs512() {
    let priv_key = a2_private_key();
    let header = format!(r#"{{"alg":"RS512","kid":"{A2_TEST_KID}"}}"#);
    let payload: &[u8] = br#"{"consentId":"abc-123","status":"ACTIVE"}"#;
    let jws = make_compact_jws(&header, payload, &priv_key, TestAlg::Rs512);

    let decoded =
        verify_compact(&jws, &[a2_pinned_key()]).expect("a genuine RS512 compact JWS must verify");
    assert_eq!(decoded, payload);
}

#[test]
fn verify_detached_accepts_an_unknown_extra_header_field() {
    let priv_key = a2_private_key();
    let header = format!(
        r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","typ":"jose","b64":false,"crit":["b64"]}}"#
    );
    let body = b"body with an ignorable typ field";
    let jws = make_detached_jws(&header, body, &priv_key, TestAlg::Rs256);

    verify_detached(&jws, body, &[a2_pinned_key()])
        .expect("an unknown but harmless header field must be ignored");
}

#[test]
fn verify_detached_accepts_an_empty_body() {
    let priv_key = a2_private_key();
    let header = detached_header(A2_TEST_KID);
    let jws = make_detached_jws(&header, b"", &priv_key, TestAlg::Rs256);

    verify_detached(&jws, b"", &[a2_pinned_key()])
        .expect("an empty body must be a valid signing input");
}

// ---------------------------------------------------------------------
// Negative
// ---------------------------------------------------------------------

#[test]
fn verify_detached_rejects_a_flipped_body_byte() {
    let priv_key = a2_private_key();
    let header = detached_header(A2_TEST_KID);
    let body = b"the original body".to_vec();
    let jws = make_detached_jws(&header, &body, &priv_key, TestAlg::Rs256);

    assert!(
        verify_detached(&jws, &body, &[a2_pinned_key()]).is_ok(),
        "baseline must verify"
    );

    let mut tampered = body.clone();
    tampered[0] ^= 0x01;

    let err = verify_detached(&jws, &tampered, &[a2_pinned_key()])
        .expect_err("a body byte flip must be caught");
    assert_eq!(err, JwsError::BadSignature);
}

#[test]
fn verify_detached_rejects_a_header_reencoded_with_the_same_json_but_different_bytes() {
    let priv_key = a2_private_key();
    let header = detached_header(A2_TEST_KID);
    let body = b"body signed under the original header bytes";
    let jws = make_detached_jws(&header, body, &priv_key, TestAlg::Rs256);

    assert!(
        verify_detached(&jws, body, &[a2_pinned_key()]).is_ok(),
        "baseline must verify"
    );

    // Same fields, reordered: identical JSON meaning, different bytes.
    let reordered =
        format!(r#"{{"kid":"{A2_TEST_KID}","alg":"RS256","crit":["b64"],"b64":false}}"#);
    let reordered_b64 = b64u(reordered.as_bytes());
    let (_original_header, middle, sig) = split_three(&jws);
    let tampered_jws = format!("{reordered_b64}.{middle}.{sig}");

    let err = verify_detached(&tampered_jws, body, &[a2_pinned_key()])
        .expect_err("re-encoding the header must invalidate its signature");
    assert_eq!(err, JwsError::BadSignature);
}

#[test]
fn verify_detached_rejects_disallowed_algorithms() {
    let priv_key = a2_private_key();
    let body = b"alg allow-list body";

    for alg in ["none", "HS256", "PS256", "ES256", "rs256"] {
        let header =
            format!(r#"{{"alg":"{alg}","kid":"{A2_TEST_KID}","b64":false,"crit":["b64"]}}"#);
        // Signed with a real RS256 signature regardless: the alg check
        // must fire before the signature is even inspected.
        let jws = make_detached_jws(&header, body, &priv_key, TestAlg::Rs256);

        let err = verify_detached(&jws, body, &[a2_pinned_key()])
            .expect_err(&format!("alg {alg} must be rejected"));
        assert_eq!(err, JwsError::BadAlg, "alg {alg}");
    }
}

#[test]
fn verify_detached_rejects_a_header_missing_kid() {
    let priv_key = a2_private_key();
    let header = r#"{"alg":"RS256","b64":false,"crit":["b64"]}"#;
    let body = b"missing kid body";
    let jws = make_detached_jws(header, body, &priv_key, TestAlg::Rs256);

    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("a header without `kid` must be rejected");
    assert_eq!(err, JwsError::BadHeader);
}

#[test]
fn verify_detached_rejects_a_header_with_a_duplicate_declared_field() {
    let priv_key = a2_private_key();
    let header = format!(
        r#"{{"alg":"RS256","alg":"RS512","kid":"{A2_TEST_KID}","b64":false,"crit":["b64"]}}"#
    );
    let body = b"duplicate alg body";
    let jws = make_detached_jws(&header, body, &priv_key, TestAlg::Rs256);

    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("a header with a duplicate declared field must be rejected");
    assert_eq!(err, JwsError::BadHeader);
}

#[test]
fn verify_detached_rejects_a_header_missing_crit() {
    let priv_key = a2_private_key();
    let header = format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":false}}"#);
    let body = b"missing crit body";
    let jws = make_detached_jws(&header, body, &priv_key, TestAlg::Rs256);

    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("a detached header without `crit` must be rejected");
    assert_eq!(err, JwsError::BadHeader);
}

#[test]
fn verify_detached_rejects_a_wrong_crit_value() {
    let priv_key = a2_private_key();
    let body = b"wrong crit body";

    for crit in [r#"["b64","exp"]"#, "[]", r#"["b64","b64"]"#] {
        let header =
            format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":false,"crit":{crit}}}"#);
        let jws = make_detached_jws(&header, body, &priv_key, TestAlg::Rs256);

        let err = verify_detached(&jws, body, &[a2_pinned_key()])
            .expect_err(&format!("crit {crit} must be rejected"));
        assert_eq!(err, JwsError::BadHeader, "crit {crit}");
    }
}

#[test]
fn verify_detached_rejects_a_wrong_b64_value() {
    let priv_key = a2_private_key();
    let body = b"wrong b64 body";

    let headers = [
        format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":true,"crit":["b64"]}}"#),
        format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":null,"crit":["b64"]}}"#),
        format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","crit":["b64"]}}"#),
    ];
    for header in &headers {
        let jws = make_detached_jws(header, body, &priv_key, TestAlg::Rs256);

        let err = verify_detached(&jws, body, &[a2_pinned_key()])
            .expect_err(&format!("header {header} must be rejected"));
        assert_eq!(err, JwsError::BadHeader, "header {header}");
    }
}

#[test]
fn verify_compact_rejects_a_header_carrying_b64_or_crit() {
    let priv_key = a2_private_key();
    let payload = b"compact payload";

    let headers = [
        format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":false}}"#),
        format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","crit":["b64"]}}"#),
    ];
    for header in &headers {
        let jws = make_compact_jws(header, payload, &priv_key, TestAlg::Rs256);

        let err = verify_compact(&jws, &[a2_pinned_key()])
            .expect_err(&format!("compact header {header} must be rejected"));
        assert_eq!(err, JwsError::BadHeader, "header {header}");
    }
}

#[test]
fn verify_detached_rejects_headers_carrying_an_embedded_key_reference() {
    let priv_key = a2_private_key();
    let body = b"embedded key reference body";

    for field_name in ["jwk", "jku", "x5u", "x5c"] {
        let header = format!(
            r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":false,"crit":["b64"],"{field_name}":"x"}}"#
        );
        let jws = make_detached_jws(&header, body, &priv_key, TestAlg::Rs256);

        let err = verify_detached(&jws, body, &[a2_pinned_key()]).expect_err(&format!(
            "{field_name} must never be trusted from the header"
        ));
        assert_eq!(err, JwsError::BadHeader, "field {field_name}");
    }
}

#[test]
fn verify_detached_rejects_an_unpinned_kid() {
    let priv_key = rfc7520_private_key();
    let kid = rfc7520_kid();
    let header = detached_header(&kid);
    let body = b"signed by a key we never pinned";
    let jws = make_detached_jws(&header, body, &priv_key, TestAlg::Rs256);

    // Only the A.2 key is pinned; the RFC 7520 kid is unknown to us.
    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("an unpinned kid must be rejected");
    assert_eq!(err, JwsError::UnknownKid);
}

#[test]
fn verify_detached_rejects_a_signature_from_the_wrong_key_under_a_known_kid() {
    let wrong_priv_key = rfc7520_private_key();
    let header = detached_header(A2_TEST_KID);
    let body = b"kid claims the a2 key, but the rfc7520 key signed it";
    let jws = make_detached_jws(&header, body, &wrong_priv_key, TestAlg::Rs256);

    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("a signature from a different key under a known kid must be rejected");
    assert_eq!(err, JwsError::BadSignature);
}

#[test]
fn verify_detached_rejects_the_wrong_segment_count() {
    for jws in ["only.two", "a.b.c.d"] {
        let err = verify_detached(jws, b"body", &[a2_pinned_key()])
            .expect_err(&format!("{jws} must be rejected"));
        assert_eq!(err, JwsError::Malformed, "jws {jws}");
    }
}

/// A fourth segment on an otherwise valid JWS: the first three alone would
/// verify, so only the segment-count check can reject it.
#[test]
fn verify_detached_rejects_a_valid_jws_with_an_extra_segment() {
    let priv_key = a2_private_key();
    let header = detached_header(A2_TEST_KID);
    let body = b"extra segment body";
    let jws = make_detached_jws(&header, body, &priv_key, TestAlg::Rs256);

    assert!(
        verify_detached(&jws, body, &[a2_pinned_key()]).is_ok(),
        "baseline must verify"
    );

    let err = verify_detached(&format!("{jws}.extra"), body, &[a2_pinned_key()])
        .expect_err("a fourth segment must be rejected");
    assert_eq!(err, JwsError::Malformed);
}

#[test]
fn verify_detached_rejects_a_non_empty_middle_segment() {
    let priv_key = a2_private_key();
    let header = detached_header(A2_TEST_KID);
    let header_b64 = b64u(header.as_bytes());
    let body = b"detached body";
    let mut signing_input = format!("{header_b64}.").into_bytes();
    signing_input.extend_from_slice(body);
    let sig = sign_raw(TestAlg::Rs256, &priv_key, &signing_input);
    let non_empty_middle = b64u(b"not-empty");
    let jws = format!("{header_b64}.{non_empty_middle}.{}", b64u(&sig));

    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("a non-empty middle segment must be rejected in detached mode");
    assert_eq!(err, JwsError::Malformed);
}

#[test]
fn verify_compact_rejects_an_empty_payload_segment() {
    let priv_key = a2_private_key();
    let header = compact_header(A2_TEST_KID);
    let header_b64 = b64u(header.as_bytes());
    let signing_input = format!("{header_b64}.");
    let sig = sign_raw(TestAlg::Rs256, &priv_key, signing_input.as_bytes());
    let jws = format!("{header_b64}..{}", b64u(&sig));

    let err = verify_compact(&jws, &[a2_pinned_key()])
        .expect_err("an empty payload segment must be rejected in compact mode");
    assert_eq!(err, JwsError::Malformed);
}

#[test]
fn verify_detached_rejects_a_malformed_signature_segment() {
    let priv_key = a2_private_key();
    let header = detached_header(A2_TEST_KID);
    let header_b64 = b64u(header.as_bytes());
    let body = b"malformed signature segment body";
    let mut signing_input = format!("{header_b64}.").into_bytes();
    signing_input.extend_from_slice(body);
    let sig = b64u(&sign_raw(TestAlg::Rs256, &priv_key, &signing_input));

    // Same underlying check (strict, canonical base64url decode), two ways
    // to fail it: padding the alphabet forbids, and characters outside it.
    let malformed_sigs = [format!("{sig}="), "not!!valid==base64url".to_owned()];
    for malformed_sig in &malformed_sigs {
        let jws = format!("{header_b64}..{malformed_sig}");

        let err = verify_detached(&jws, body, &[a2_pinned_key()]).expect_err(&format!(
            "signature segment {malformed_sig} must be rejected"
        ));
        assert_eq!(err, JwsError::Malformed, "segment {malformed_sig}");
    }
}

#[test]
fn verify_detached_rejects_an_rs512_signature_presented_as_rs256() {
    let priv_key = a2_private_key();
    let header = detached_header(A2_TEST_KID); // claims RS256
    let header_b64 = b64u(header.as_bytes());
    let body = b"rs512 signature, rs256 header";
    let mut signing_input = format!("{header_b64}.").into_bytes();
    signing_input.extend_from_slice(body);
    let sig = sign_raw(TestAlg::Rs512, &priv_key, &signing_input);
    let jws = format!("{header_b64}..{}", b64u(&sig));

    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("an RS512 signature must not verify as RS256");
    assert_eq!(err, JwsError::BadSignature);
}

// ---------------------------------------------------------------------
// FiuSigningKey::sign_detached
// ---------------------------------------------------------------------

#[test]
fn sign_detached_produces_the_exact_header_bytes() {
    let signing = FiuSigningKey::from_private_key(A2_TEST_KID.to_owned(), a2_private_key());
    let mut rng = ChaCha20Rng::seed_from_u64(3);
    let body = b"exact header bytes body";

    let jws = signing
        .sign_detached(body, &mut rng)
        .expect("signing must succeed");
    let (header_b64, middle, _sig) = split_three(&jws);
    assert_eq!(middle, "", "detached form has an empty middle segment");

    let header_bytes = URL_SAFE_NO_PAD
        .decode(header_b64)
        .expect("a valid base64url header segment");
    let expected = format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":false,"crit":["b64"]}}"#);
    assert_eq!(header_bytes, expected.as_bytes());
}

// ---------------------------------------------------------------------
// ErrorCode
// ---------------------------------------------------------------------

#[test]
fn error_codes_match_the_spec() {
    assert_eq!(JwsError::Malformed.code(), "bad_jws");
    assert_eq!(JwsError::BadHeader.code(), "bad_header");
    assert_eq!(JwsError::BadAlg.code(), "bad_alg");
    assert_eq!(JwsError::UnknownKid.code(), "unknown_kid");
    assert_eq!(JwsError::BadSignature.code(), "bad_signature");
    assert_eq!(JwsError::BadPinnedKey.code(), "bad_pinned_key");
    assert_eq!(JwsError::SignFailed.code(), "sign_failed");
}

// ---------------------------------------------------------------------
// Review round 1: object-only header, strict base64url, null presence,
// check order
// ---------------------------------------------------------------------

/// Signs `header_b64 || "." || body` exactly as given, so a test can put a
/// header segment on the wire that `b64u` would never produce.
fn detached_jws_over_raw_header(header_b64: &str, body: &[u8]) -> String {
    let mut signing_input = format!("{header_b64}.").into_bytes();
    signing_input.extend_from_slice(body);
    let sig = sign_raw(TestAlg::Rs256, &a2_private_key(), &signing_input);
    format!("{header_b64}..{}", b64u(&sig))
}

#[test]
fn verify_detached_rejects_a_json_array_header() {
    // serde's derived struct visitor also reads arrays by position; this
    // array maps onto (alg, kid, b64, crit) with a valid signature.
    let header = format!(r#"["RS256","{A2_TEST_KID}",false,["b64"]]"#);
    let body = b"array header body";
    let jws = make_detached_jws(&header, body, &a2_private_key(), TestAlg::Rs256);

    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("a header that is not a JSON object must be rejected");
    assert_eq!(err, JwsError::BadHeader);
}

#[test]
fn verify_detached_rejects_a_correctly_padded_signature_segment() {
    let body = b"padded signature body";
    let jws = make_detached_jws(
        &detached_header(A2_TEST_KID),
        body,
        &a2_private_key(),
        TestAlg::Rs256,
    );
    assert!(
        verify_detached(&jws, body, &[a2_pinned_key()]).is_ok(),
        "baseline must verify"
    );

    // 256-byte signature: 342 chars unpadded, so `==` is the *correct*
    // standard padding. Only a no-padding-strict decoder rejects it.
    let (header_b64, _, sig_b64) = split_three(&jws);
    assert_eq!(sig_b64.len() % 4, 2);
    let padded = format!("{header_b64}..{sig_b64}==");

    let err = verify_detached(&padded, body, &[a2_pinned_key()])
        .expect_err("padding must be rejected even when it is well-formed");
    assert_eq!(err, JwsError::Malformed);
}

#[test]
fn verify_detached_rejects_a_header_with_non_canonical_trailing_bits() {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let body = b"non-canonical header body";
    // The last char carries unused low bits only when the header's byte
    // length isn't a multiple of 3; an ignored `typ` member adjusts it.
    let header =
        format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":false,"crit":["b64"],"typ":"x"}}"#);
    assert_ne!(header.len() % 3, 0);
    let header_b64 = b64u(header.as_bytes());
    assert!(
        verify_detached(
            &detached_jws_over_raw_header(&header_b64, body),
            body,
            &[a2_pinned_key()]
        )
        .is_ok(),
        "baseline: the canonical header verifies"
    );
    let last = *header_b64.as_bytes().last().unwrap();
    let index = ALPHABET.iter().position(|&c| c == last).unwrap();
    // Canonical encoding leaves the unused bits zero; set the lowest one.
    // It decodes to the same bytes under a lenient decoder.
    let bumped = ALPHABET[index + 1] as char;
    let non_canonical = format!("{}{bumped}", &header_b64[..header_b64.len() - 1]);

    // Signed over the non-canonical text itself, so the signature is valid
    // and only the decoder can reject it.
    let jws = detached_jws_over_raw_header(&non_canonical, body);
    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("non-canonical base64url must be rejected");
    assert_eq!(err, JwsError::Malformed);
}

#[test]
fn verify_detached_rejects_embedded_key_members_with_null_values() {
    let body = b"null embedded key body";
    for field_name in ["jwk", "jku", "x5u", "x5c"] {
        let header = format!(
            r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":false,"crit":["b64"],"{field_name}":null}}"#
        );
        let jws = make_detached_jws(&header, body, &a2_private_key(), TestAlg::Rs256);

        let err = verify_detached(&jws, body, &[a2_pinned_key()])
            .expect_err(&format!("{field_name}: null must count as present"));
        assert_eq!(err, JwsError::BadHeader, "field {field_name}");
    }
}

#[test]
fn verify_compact_rejects_b64_or_crit_with_null_values() {
    let payload = b"compact payload";
    for member in ["b64", "crit"] {
        let header = format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","{member}":null}}"#);
        let jws = make_compact_jws(&header, payload, &a2_private_key(), TestAlg::Rs256);

        let err = verify_compact(&jws, &[a2_pinned_key()])
            .expect_err(&format!("{member}: null must count as present"));
        assert_eq!(err, JwsError::BadHeader, "member {member}");
    }
}

#[test]
fn verify_detached_checks_alg_before_kid() {
    let header = r#"{"alg":"none","kid":"not-pinned","b64":false,"crit":["b64"]}"#;
    let body = b"alg before kid body";
    let jws = make_detached_jws(header, body, &a2_private_key(), TestAlg::Rs256);

    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("a bad alg must be reported before an unknown kid");
    assert_eq!(err, JwsError::BadAlg);
}

#[test]
fn verify_detached_checks_header_rules_before_kid() {
    let header = r#"{"alg":"RS256","kid":"not-pinned","b64":false,"crit":["b64"],"jwk":{}}"#;
    let body = b"header rules before kid body";
    let jws = make_detached_jws(header, body, &a2_private_key(), TestAlg::Rs256);

    let err = verify_detached(&jws, body, &[a2_pinned_key()])
        .expect_err("an embedded key must be reported before an unknown kid");
    assert_eq!(err, JwsError::BadHeader);
}

#[test]
fn verify_detached_rejects_repeated_presence_checked_members() {
    let body = b"repeated presence-checked member body";
    let headers = [
        format!(r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":true,"b64":false,"crit":["b64"]}}"#),
        format!(
            r#"{{"alg":"RS256","kid":"{A2_TEST_KID}","b64":false,"crit":["b64"],"jwk":{{}},"jwk":{{}}}}"#
        ),
    ];
    for header in &headers {
        let jws = make_detached_jws(header, body, &a2_private_key(), TestAlg::Rs256);

        let err = verify_detached(&jws, body, &[a2_pinned_key()])
            .expect_err(&format!("header {header} must be rejected"));
        assert_eq!(err, JwsError::BadHeader, "header {header}");
    }
}
