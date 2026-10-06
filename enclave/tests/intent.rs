//! Wallet intent (FORMATS §9): the exact text and its Ed25519 verification.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use ed25519_dalek::{Signer, SigningKey};
use tio_enclave::{
    intent::{build_intent, verify_intent},
    ApiError,
};

use common::{b58_32, hex32};

const SESSION_ID: &str = "232c88fe-595d-4809-b82f-bedf270b4887";
const WALLET_B58: &str = "3bq9cT2LQ1SKiSS31rEsmdYrUjw6A8qY8CDJmMbSuHWS";
const POLICY_HEX: &str = "81112a23f4ee2835f6459b1f25d9159566204bc2e3e4d318b3ac73d526932e1c";
const EXPIRES: i64 = 1_790_417_400;

fn signer(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn wallet_of(key: &SigningKey) -> [u8; 32] {
    key.verifying_key().to_bytes()
}

fn sign_b58(key: &SigningKey, message: &str) -> String {
    bs58::encode(key.sign(message.as_bytes()).to_bytes()).into_string()
}

fn intent_for(key: &SigningKey) -> String {
    build_intent(SESSION_ID, &wallet_of(key), &hex32(POLICY_HEX), EXPIRES)
}

// --- build_intent -------------------------------------------------------------

#[test]
fn intent_is_the_exact_section_9_text() {
    let intent = build_intent(SESSION_ID, &b58_32(WALLET_B58), &hex32(POLICY_HEX), EXPIRES);
    assert_eq!(
        intent,
        "tee-income-oracle: bind session\n\
         session: 232c88fe-595d-4809-b82f-bedf270b4887\n\
         wallet: 3bq9cT2LQ1SKiSS31rEsmdYrUjw6A8qY8CDJmMbSuHWS\n\
         policy: 81112a23f4ee2835f6459b1f25d9159566204bc2e3e4d318b3ac73d526932e1c\n\
         expires: 1790417400"
    );
}

#[test]
fn intent_has_five_lines_and_no_trailing_newline() {
    let intent = build_intent(SESSION_ID, &b58_32(WALLET_B58), &hex32(POLICY_HEX), EXPIRES);
    assert_eq!(intent.split('\n').count(), 5);
    assert!(!intent.ends_with('\n'));
    assert!(!intent.contains('\r'));
}

#[test]
fn intent_policy_line_is_64_lowercase_hex_with_leading_zeros_kept() {
    let intent = build_intent(SESSION_ID, &b58_32(WALLET_B58), &[0u8; 32], EXPIRES);
    assert!(
        intent.contains(&format!("\npolicy: {}\n", "0".repeat(64))),
        "{intent}"
    );
    let mut hash = [0u8; 32];
    hash[0] = 0xAB;
    hash[31] = 0x0F;
    let intent = build_intent(SESSION_ID, &b58_32(WALLET_B58), &hash, EXPIRES);
    let line = intent.lines().nth(3).expect("policy line");
    let hex_part = line.strip_prefix("policy: ").expect("prefix");
    assert_eq!(hex_part.len(), 64);
    assert!(hex_part.starts_with("ab") && hex_part.ends_with("0f"));
}

#[test]
fn intent_wallet_line_is_the_base58_of_the_32_bytes() {
    let wallet = wallet_of(&signer(3));
    let intent = build_intent(SESSION_ID, &wallet, &hex32(POLICY_HEX), EXPIRES);
    let line = intent.lines().nth(2).expect("wallet line");
    assert_eq!(
        line,
        format!("wallet: {}", bs58::encode(wallet).into_string())
    );
}

#[test]
fn intent_expires_line_is_the_decimal_unix_seconds() {
    let intent = build_intent(SESSION_ID, &b58_32(WALLET_B58), &hex32(POLICY_HEX), 0);
    assert!(intent.ends_with("\nexpires: 0"), "{intent}");
}

#[test]
fn intent_differs_when_any_input_differs() {
    let base = build_intent(SESSION_ID, &b58_32(WALLET_B58), &hex32(POLICY_HEX), EXPIRES);
    assert_ne!(
        base,
        build_intent("other", &b58_32(WALLET_B58), &hex32(POLICY_HEX), EXPIRES)
    );
    assert_ne!(
        base,
        build_intent(SESSION_ID, &[9u8; 32], &hex32(POLICY_HEX), EXPIRES)
    );
    assert_ne!(
        base,
        build_intent(SESSION_ID, &b58_32(WALLET_B58), &[1u8; 32], EXPIRES)
    );
    assert_ne!(
        base,
        build_intent(
            SESSION_ID,
            &b58_32(WALLET_B58),
            &hex32(POLICY_HEX),
            EXPIRES + 1
        )
    );
}

// --- verify_intent ------------------------------------------------------------

#[test]
fn verify_accepts_the_wallets_signature_over_the_exact_intent() {
    let key = signer(1);
    let intent = intent_for(&key);
    assert_eq!(
        verify_intent(&intent, &wallet_of(&key), &sign_b58(&key, &intent)),
        Ok(())
    );
}

#[test]
fn verify_rejects_a_signature_over_a_different_message() {
    let key = signer(1);
    let intent = intent_for(&key);
    let sig = sign_b58(&key, &format!("{intent}\n"));
    assert_eq!(
        verify_intent(&intent, &wallet_of(&key), &sig),
        Err(ApiError::BAD_INTENT_SIGNATURE)
    );
}

#[test]
fn verify_rejects_another_wallets_signature() {
    let (key, other) = (signer(1), signer(2));
    let intent = intent_for(&key);
    let sig = sign_b58(&other, &intent);
    assert_eq!(
        verify_intent(&intent, &wallet_of(&key), &sig),
        Err(ApiError::BAD_INTENT_SIGNATURE)
    );
}

#[test]
fn verify_rejects_a_valid_signature_checked_against_another_wallet() {
    let (key, other) = (signer(1), signer(2));
    let intent = intent_for(&key);
    let sig = sign_b58(&key, &intent);
    assert_eq!(
        verify_intent(&intent, &wallet_of(&other), &sig),
        Err(ApiError::BAD_INTENT_SIGNATURE)
    );
}

#[test]
fn verify_rejects_a_flipped_signature_bit() {
    let key = signer(1);
    let intent = intent_for(&key);
    let mut raw = key.sign(intent.as_bytes()).to_bytes();
    raw[10] ^= 0x01;
    let sig = bs58::encode(raw).into_string();
    assert_eq!(
        verify_intent(&intent, &wallet_of(&key), &sig),
        Err(ApiError::BAD_INTENT_SIGNATURE)
    );
}

#[test]
fn verify_rejects_a_non_canonical_s_with_verify_strict() {
    // s + L is the same scalar mod L but non-canonical; verify_strict refuses it.
    const L: [u8; 32] = [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde,
        0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
    ];
    let key = signer(1);
    let intent = intent_for(&key);
    let mut raw = key.sign(intent.as_bytes()).to_bytes();
    let mut carry = 0u16;
    for i in 0..32 {
        let sum = u16::from(raw[32 + i]) + u16::from(L[i]) + carry;
        raw[32 + i] = u8::try_from(sum & 0xFF).unwrap();
        carry = sum >> 8;
    }
    let sig = bs58::encode(raw).into_string();
    let result = verify_intent(&intent, &wallet_of(&key), &sig);
    assert_eq!(result, Err(ApiError::BAD_INTENT_SIGNATURE));
}

#[test]
fn verify_rejects_a_signature_that_is_not_base58_as_bad_request() {
    let key = signer(1);
    assert_eq!(
        verify_intent(&intent_for(&key), &wallet_of(&key), "0OIl-not-base58"),
        Err(ApiError::BAD_REQUEST)
    );
}

#[test]
fn verify_rejects_empty_signature_as_bad_request() {
    let key = signer(1);
    assert_eq!(
        verify_intent(&intent_for(&key), &wallet_of(&key), ""),
        Err(ApiError::BAD_REQUEST)
    );
}

#[test]
fn verify_rejects_a_63_or_65_byte_signature_as_bad_request() {
    let key = signer(1);
    let intent = intent_for(&key);
    let raw = key.sign(intent.as_bytes()).to_bytes();
    let short = bs58::encode(&raw[..63]).into_string();
    let mut long = raw.to_vec();
    long.push(0);
    let long = bs58::encode(long).into_string();
    assert_eq!(
        verify_intent(&intent, &wallet_of(&key), &short),
        Err(ApiError::BAD_REQUEST)
    );
    assert_eq!(
        verify_intent(&intent, &wallet_of(&key), &long),
        Err(ApiError::BAD_REQUEST)
    );
}

#[test]
fn verify_never_accepts_a_small_order_wallet() {
    // The identity point (y = 1) is a valid but small-order key.
    let mut identity = [0u8; 32];
    identity[0] = 1;
    let key = signer(1);
    let intent = intent_for(&key);
    let sig = sign_b58(&key, &intent);
    let result = verify_intent(&intent, &identity, &sig);
    assert!(
        result == Err(ApiError::BAD_REQUEST) || result == Err(ApiError::BAD_INTENT_SIGNATURE),
        "{result:?}"
    );
}

#[test]
fn api_error_statuses_are_400_and_401() {
    assert_eq!(ApiError::BAD_REQUEST.status.as_u16(), 400);
    assert_eq!(ApiError::BAD_INTENT_SIGNATURE.status.as_u16(), 401);
    assert_eq!(ApiError::BAD_INTENT_SIGNATURE.code, "bad_intent_signature");
}
