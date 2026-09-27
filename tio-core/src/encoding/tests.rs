#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use serde_json::Value;

use super::*;

fn ecc_vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../test-vectors/golden/rahasya/ecc.json"
    ))
    .expect("ecc.json is valid JSON")
}

/// A real rahasya single-line PEM `KeyValue` (309-byte wei25519 SPKI).
fn sample_single_line_pem() -> String {
    ecc_vectors()["vectors"][0]["fip"]["key_material"]["DHPublicKey"]["KeyValue"]
        .as_str()
        .expect("string")
        .to_owned()
}

fn bare_base64(pem: &str) -> String {
    pem.replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
}

fn wrap_64_columns(b64: &str) -> String {
    b64.as_bytes()
        .chunks(64)
        .map(|c| std::str::from_utf8(c).expect("base64 is ASCII"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn pem_to_der_accepts_single_line_pem() {
    let pem = sample_single_line_pem();
    let der = pem_to_der(&pem).expect("a real rahasya single-line PEM must parse");
    assert_eq!(der.len(), 309);

    let expected = base64::engine::general_purpose::STANDARD
        .decode(bare_base64(&pem))
        .expect("valid base64");
    assert_eq!(der, expected);
}

#[test]
fn pem_to_der_accepts_64_column_wrapped_pem() {
    // rahasya itself rejects this on the wire, but our parser is lenient on
    // input (`docs/FORMATS.md` §3): it strips any armour and whitespace.
    let pem = sample_single_line_pem();
    let b64 = bare_base64(&pem);
    let wrapped = format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
        wrap_64_columns(&b64)
    );

    let der = pem_to_der(&wrapped).expect("a 64-column wrapped PEM must still parse");
    let expected = base64::engine::general_purpose::STANDARD
        .decode(&b64)
        .expect("valid base64");
    assert_eq!(der, expected);
}

#[test]
fn pem_to_der_accepts_crlf_line_endings() {
    let pem = sample_single_line_pem();
    let b64 = bare_base64(&pem);
    let wrapped = wrap_64_columns(&b64).replace('\n', "\r\n");
    let crlf_pem =
        format!("-----BEGIN PUBLIC KEY-----\r\n{wrapped}\r\n-----END PUBLIC KEY-----\r\n");

    let der = pem_to_der(&crlf_pem).expect("CRLF line endings must still parse");
    let expected = base64::engine::general_purpose::STANDARD
        .decode(&b64)
        .expect("valid base64");
    assert_eq!(der, expected);
}

#[test]
fn pem_to_der_accepts_bare_base64_without_armour() {
    let pem = sample_single_line_pem();
    let b64 = bare_base64(&pem);

    let der = pem_to_der(&b64).expect("bare base64 with no armour must parse");
    let expected = base64::engine::general_purpose::STANDARD
        .decode(&b64)
        .expect("valid base64");
    assert_eq!(der, expected);
}

#[test]
fn pem_to_der_rejects_bad_base64() {
    let err = pem_to_der("-----BEGIN PUBLIC KEY-----not-valid-base64!!-----END PUBLIC KEY-----")
        .expect_err("invalid base64 must be rejected");
    assert_eq!(err, BadEncoding);
}

#[test]
fn der_to_single_line_pem_emits_expected_format_and_round_trips() {
    let pem = sample_single_line_pem();
    let b64 = bare_base64(&pem);
    let der = base64::engine::general_purpose::STANDARD
        .decode(&b64)
        .expect("valid base64");

    let emitted = der_to_single_line_pem(&der);
    assert_eq!(
        emitted,
        format!("-----BEGIN PUBLIC KEY-----{b64}-----END PUBLIC KEY-----")
    );
    assert!(!emitted.contains('\n'));

    let round_tripped = pem_to_der(&emitted).expect("our own emitted PEM must parse");
    assert_eq!(round_tripped, der);
}
