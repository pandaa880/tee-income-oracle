//! The secp256k1 attester key (FORMATS §8, §8.1): address, recoverable
//! low-s signatures over keccak256, key loading, FIU-key binding message.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use std::{fs, path::PathBuf};

use sha2::{Digest, Sha256};
use tio_enclave::attester::{
    fiu_binding_message, Attester, AttesterError, FIU_BINDING_LEN, FIU_KEY_DOMAIN_TAG,
};

use common::{address_hex, enclave_test_secret, eth_address_of, recover_address, repo_root};

const ADDRESS_KEY_1: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const ADDRESS_KEY_2: &str = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf";

/// secp256k1 group order n, big-endian.
const ORDER_N: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
    0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
];

fn scalar(last: u8) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[31] = last;
    bytes
}

fn attester(secret: &[u8]) -> Attester {
    Attester::from_bytes(secret, "test key").expect("valid key")
}

fn temp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "tio-enclave-attester-{}-{name}",
        std::process::id()
    ))
}

// --- address ------------------------------------------------------------------

#[test]
fn private_key_one_has_the_known_ethereum_address() {
    assert_eq!(attester(&scalar(1)).address_hex(), ADDRESS_KEY_1);
}

#[test]
fn private_key_two_has_the_known_ethereum_address() {
    assert_eq!(attester(&scalar(2)).address_hex(), ADDRESS_KEY_2);
}

#[test]
fn address_hex_is_0x_plus_40_lowercase_hex_characters() {
    let text = attester(&scalar(1)).address_hex();
    assert_eq!(text.len(), 42);
    assert!(text.starts_with("0x"));
    assert!(text[2..]
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
}

#[test]
fn eth_address_bytes_match_address_hex() {
    let a = attester(&scalar(1));
    assert_eq!(address_hex(&a.eth_address()), a.address_hex());
    assert_eq!(a.eth_address().len(), 20);
}

#[test]
fn committed_test_key_address_matches_an_independent_derivation() {
    let secret = enclave_test_secret("secp256k1_hex");
    let a = attester(&secret);
    assert_eq!(a.eth_address(), eth_address_of(&secret));
    assert_ne!(a.eth_address(), [0u8; 20]);
}

// --- sign ---------------------------------------------------------------------

#[test]
fn signature_is_65_bytes_and_recovers_to_the_attester_address() {
    for last in [1u8, 2] {
        let a = attester(&scalar(last));
        let message = [0x5Au8; 232];
        let sig = a.sign(&message).expect("sign");
        assert_eq!(sig.len(), 65);
        assert_eq!(recover_address(&message, &sig), a.eth_address());
    }
}

#[test]
fn signature_v_is_zero_or_one_never_27_or_28() {
    let a = attester(&scalar(1));
    for i in 0u8..16 {
        let sig = a.sign(&[i; 40]).expect("sign");
        assert!(sig[64] <= 1, "v = {}", sig[64]);
    }
}

#[test]
fn signature_s_is_low_for_many_messages() {
    use k256::ecdsa::Signature;
    let a = attester(&scalar(2));
    for i in 0u8..32 {
        let sig = a.sign(&[i; 64]).expect("sign");
        let parsed = Signature::from_slice(&sig[..64]).expect("r ‖ s");
        assert!(parsed.normalize_s().is_none(), "high s for message {i}");
    }
}

#[test]
fn signature_is_over_keccak256_of_the_message_not_the_message_itself() {
    let a = attester(&scalar(1));
    let sig = a.sign(b"hello").expect("sign");
    assert_eq!(recover_address(b"hello", &sig), a.eth_address());
    assert_ne!(recover_address(b"hellp", &sig), a.eth_address());
}

#[test]
fn signs_the_empty_message() {
    let a = attester(&scalar(1));
    let sig = a.sign(b"").expect("sign");
    assert_eq!(recover_address(b"", &sig), a.eth_address());
}

#[test]
fn committed_test_key_sign_recover_round_trip() {
    let secret = enclave_test_secret("secp256k1_hex");
    let a = attester(&secret);
    let message = b"TIO-ATTEST-v1 round trip";
    let sig = a.sign(message).expect("sign");
    assert_eq!(recover_address(message, &sig), eth_address_of(&secret));
}

// --- from_bytes ---------------------------------------------------------------

#[test]
fn from_bytes_rejects_31_bytes_as_bad_length() {
    let err = Attester::from_bytes(&[1u8; 31], "label").expect_err("short");
    assert!(matches!(err, AttesterError::BadLength { .. }), "{err:?}");
}

#[test]
fn from_bytes_rejects_33_bytes_as_bad_length() {
    let err = Attester::from_bytes(&[1u8; 33], "label").expect_err("long");
    assert!(matches!(err, AttesterError::BadLength { .. }), "{err:?}");
}

#[test]
fn from_bytes_rejects_empty_input_as_bad_length() {
    let err = Attester::from_bytes(&[], "label").expect_err("empty");
    assert!(matches!(err, AttesterError::BadLength { .. }), "{err:?}");
}

#[test]
fn from_bytes_rejects_the_zero_scalar() {
    let err = Attester::from_bytes(&[0u8; 32], "label").expect_err("zero");
    assert!(matches!(err, AttesterError::InvalidKey { .. }), "{err:?}");
}

#[test]
fn from_bytes_rejects_a_scalar_equal_to_the_group_order() {
    let err = Attester::from_bytes(&ORDER_N, "label").expect_err("n");
    assert!(matches!(err, AttesterError::InvalidKey { .. }), "{err:?}");
}

#[test]
fn from_bytes_rejects_a_scalar_above_the_group_order() {
    let err = Attester::from_bytes(&[0xFF; 32], "label").expect_err("2^256-1");
    assert!(matches!(err, AttesterError::InvalidKey { .. }), "{err:?}");
}

#[test]
fn from_bytes_accepts_the_largest_valid_scalar_n_minus_one() {
    let mut n_minus_1 = ORDER_N;
    n_minus_1[31] -= 1;
    let a = attester(&n_minus_1);
    let sig = a.sign(b"edge").expect("sign");
    assert_eq!(recover_address(b"edge", &sig), a.eth_address());
}

#[test]
fn errors_carry_the_label_and_never_the_key_bytes() {
    let secret = [0xFFu8; 32];
    let err = Attester::from_bytes(&secret, "my-label").expect_err("invalid");
    let shown = format!("{err} | {err:?}");
    assert!(shown.contains("my-label"), "{shown}");
    assert!(
        !shown.to_lowercase().contains(&hex::encode(secret)),
        "{shown}"
    );
}

#[test]
fn debug_output_never_shows_the_key() {
    let secret = enclave_test_secret("secp256k1_hex");
    let shown = format!("{:?}", attester(&secret));
    assert!(
        !shown.to_lowercase().contains(&hex::encode(secret)),
        "{shown}"
    );
}

// --- from_file ----------------------------------------------------------------

#[test]
fn from_file_reads_a_raw_32_byte_key() {
    let path = temp_path("good.sec");
    fs::write(&path, scalar(1)).expect("write");
    let loaded = Attester::from_file(&path);
    fs::remove_file(&path).ok();
    assert_eq!(loaded.expect("loads").address_hex(), ADDRESS_KEY_1);
}

#[test]
fn from_file_on_a_missing_path_is_a_read_error_naming_the_path() {
    let path = temp_path("missing.sec");
    let err = Attester::from_file(&path).expect_err("missing");
    assert!(matches!(err, AttesterError::Read { .. }), "{err:?}");
    assert!(
        err.to_string().contains(&path.display().to_string()),
        "{err}"
    );
}

#[test]
fn from_file_with_a_short_file_is_bad_length_and_never_prints_its_bytes() {
    let path = temp_path("short.sec");
    let secret = [0xABu8; 31];
    fs::write(&path, secret).expect("write");
    let result = Attester::from_file(&path);
    fs::remove_file(&path).ok();
    let err = result.expect_err("short");
    assert!(matches!(err, AttesterError::BadLength { .. }), "{err:?}");
    let shown = format!("{err} | {err:?}");
    assert!(shown.contains(&path.display().to_string()), "{shown}");
    assert!(
        !shown.to_lowercase().contains(&hex::encode(secret)),
        "{shown}"
    );
}

#[test]
fn from_file_with_hex_text_instead_of_raw_bytes_is_bad_length() {
    let path = temp_path("hextext.sec");
    fs::write(&path, hex::encode(scalar(1))).expect("write");
    let result = Attester::from_file(&path);
    fs::remove_file(&path).ok();
    let err = result.expect_err("64 ascii bytes");
    assert!(matches!(err, AttesterError::BadLength { .. }), "{err:?}");
}

#[test]
fn from_file_with_the_zero_scalar_is_an_invalid_key_error_naming_the_path() {
    let path = temp_path("zero.sec");
    fs::write(&path, [0u8; 32]).expect("write");
    let result = Attester::from_file(&path);
    fs::remove_file(&path).ok();
    let err = result.expect_err("zero");
    assert!(matches!(err, AttesterError::InvalidKey { .. }), "{err:?}");
    assert!(
        err.to_string().contains(&path.display().to_string()),
        "{err}"
    );
}

#[test]
fn from_file_on_a_directory_is_a_read_error() {
    let err = Attester::from_file(&repo_root()).expect_err("directory");
    assert!(matches!(err, AttesterError::Read { .. }), "{err:?}");
}

// --- §8.1 FIU key binding message -------------------------------------------------

#[test]
fn binding_message_is_domain_tag_then_sha256_of_the_jcs_bytes() {
    let jcs = br#"{"e":"AQAB","kid":"k","kty":"RSA","n":"AAAA"}"#;
    let msg = fiu_binding_message(jcs);
    assert_eq!(msg.len(), 46);
    assert_eq!(FIU_BINDING_LEN, 46);
    assert_eq!(FIU_KEY_DOMAIN_TAG, b"TIO-FIU-KEY-v1");
    assert_eq!(&msg[..14], b"TIO-FIU-KEY-v1");
    assert_eq!(&msg[14..], Sha256::digest(jcs).as_slice());
}

#[test]
fn binding_message_changes_when_any_jwk_byte_changes() {
    let a = fiu_binding_message(br#"{"e":"AQAB","kid":"a","kty":"RSA","n":"AAAA"}"#);
    let b = fiu_binding_message(br#"{"e":"AQAB","kid":"b","kty":"RSA","n":"AAAA"}"#);
    assert_ne!(a, b);
}

#[test]
fn binding_signature_recovers_to_the_attester_address() {
    let a = attester(&scalar(1));
    let msg = fiu_binding_message(br#"{"e":"AQAB","kid":"k","kty":"RSA","n":"AAAA"}"#);
    let sig = a.sign(&msg).expect("sign");
    assert_eq!(address_hex(&recover_address(&msg, &sig)), ADDRESS_KEY_1);
}
