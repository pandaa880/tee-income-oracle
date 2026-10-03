//! Attestation payload and signed-message tests (FORMATS §7, §8). Written
//! red-first by test-designer.
//!
//! Expected bytes are assembled by hand from the §7/§8 tables, field by
//! field, never by calling the builders. Every field gets its own byte
//! pattern so a swapped or shifted field turns a test red.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use super::*;
use crate::policy::{Policy, PolicyHash};
use crate::Tier;

/// `sha256(JCS(default policy))`, copied from `test-vectors/policy/default.hash`.
const POLICY_HASH_HEX: &str = "81112a23f4ee2835f6459b1f25d9159566204bc2e3e4d318b3ac73d526932e1c";

const MEASUREMENT_ID: u8 = 0x2A;
const ISSUED_AT: i64 = 0x0102_0304_0506_0708;
const WINDOW_FROM: u32 = 0x1122_3344;
const WINDOW_TO: u32 = 0x5566_7788;

fn policy_hash() -> PolicyHash {
    let bytes = include_bytes!("../../../test-vectors/policy/default.json");
    Policy::from_json(bytes).unwrap().hash()
}

fn policy_hash_bytes() -> [u8; 32] {
    hex::decode(POLICY_HASH_HEX).unwrap().try_into().unwrap()
}

/// 0x80, 0x81, ... 0x9F: distinct from the policy hash and every id byte.
fn consent_hash() -> [u8; 32] {
    std::array::from_fn(|i| 0x80 + u8::try_from(i).unwrap())
}

fn fields() -> PayloadFields {
    PayloadFields {
        tier: Tier::B,
        proof_type: ProofType::TeeNitroOyster,
        measurement_id: MEASUREMENT_ID,
        policy_hash: policy_hash(),
        consent_hash: consent_hash(),
        issued_at: ISSUED_AT,
        window_from: WINDOW_FROM,
        window_to: WINDOW_TO,
    }
}

fn context() -> AttestContext {
    AttestContext {
        oracle_program_id: [0x11; 32],
        sas_credential: [0x22; 32],
        sas_schema: [0x33; 32],
        proof_type: ProofType::TeeNitroOyster,
        measurement_id: MEASUREMENT_ID,
    }
}

const WALLET: [u8; 32] = [0x44; 32];

/// The §7 table, hand-assembled for `fields()`.
fn expected_payload() -> Vec<u8> {
    let mut out = vec![2u8, 1, MEASUREMENT_ID];
    out.extend_from_slice(&policy_hash_bytes());
    out.extend_from_slice(&consent_hash());
    out.extend_from_slice(&[0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
    out.extend_from_slice(&[0x44, 0x33, 0x22, 0x11]);
    out.extend_from_slice(&[0x88, 0x77, 0x66, 0x55]);
    out
}

// --- constants ---------------------------------------------------------

#[test]
fn payload_is_83_bytes() {
    assert_eq!(PAYLOAD_LEN, 83);
}

#[test]
fn message_is_232_bytes() {
    assert_eq!(MESSAGE_LEN, 232);
}

#[test]
fn domain_tag_is_the_13_byte_v1_tag() {
    assert_eq!(DOMAIN_TAG.as_slice(), b"TIO-ATTEST-v1");
    assert_eq!(DOMAIN_TAG.len(), 13);
}

#[test]
fn tee_nitro_oyster_proof_type_is_one() {
    assert_eq!(ProofType::TeeNitroOyster as u8, 1);
}

#[test]
fn policy_hash_fixture_matches_the_committed_hash() {
    // Guards the test's own fixture: the hash baked above is the real one.
    assert_eq!(policy_hash().as_bytes(), &policy_hash_bytes());
}

// --- payload -----------------------------------------------------------

#[test]
fn payload_matches_the_hand_assembled_table() {
    let payload = build_payload(&fields());
    assert_eq!(payload.len(), PAYLOAD_LEN);
    assert_eq!(payload.as_slice(), expected_payload().as_slice());
}

#[test]
fn payload_tier_byte_is_1_for_a() {
    let payload = build_payload(&PayloadFields {
        tier: Tier::A,
        ..fields()
    });
    assert_eq!(payload[0], 1);
}

#[test]
fn payload_tier_byte_is_2_for_b() {
    let payload = build_payload(&PayloadFields {
        tier: Tier::B,
        ..fields()
    });
    assert_eq!(payload[0], 2);
}

#[test]
fn payload_tier_byte_is_3_for_c() {
    let payload = build_payload(&PayloadFields {
        tier: Tier::C,
        ..fields()
    });
    assert_eq!(payload[0], 3);
}

#[test]
fn payload_proof_type_is_byte_1_at_offset_1() {
    assert_eq!(build_payload(&fields())[1], 1);
}

#[test]
fn payload_measurement_id_is_at_offset_2() {
    assert_eq!(build_payload(&fields())[2], MEASUREMENT_ID);
    let other = build_payload(&PayloadFields {
        measurement_id: 0xFF,
        ..fields()
    });
    assert_eq!(other[2], 0xFF);
}

#[test]
fn payload_policy_hash_occupies_offsets_3_to_35() {
    let payload = build_payload(&fields());
    assert_eq!(&payload[3..35], &policy_hash_bytes());
}

#[test]
fn payload_consent_hash_occupies_offsets_35_to_67() {
    let payload = build_payload(&fields());
    assert_eq!(&payload[35..67], &consent_hash());
}

#[test]
fn payload_issued_at_is_i64_little_endian_at_67() {
    let payload = build_payload(&fields());
    assert_eq!(
        &payload[67..75],
        &[0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]
    );
}

#[test]
fn payload_issued_at_negative_is_twos_complement_little_endian() {
    let payload = build_payload(&PayloadFields {
        issued_at: -2,
        ..fields()
    });
    assert_eq!(
        &payload[67..75],
        &[0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]
    );
}

#[test]
fn payload_issued_at_i64_min_sets_only_the_top_byte() {
    let payload = build_payload(&PayloadFields {
        issued_at: i64::MIN,
        ..fields()
    });
    assert_eq!(&payload[67..75], &[0, 0, 0, 0, 0, 0, 0, 0x80]);
}

#[test]
fn payload_window_from_is_u32_little_endian_at_75() {
    let payload = build_payload(&fields());
    assert_eq!(&payload[75..79], &[0x44, 0x33, 0x22, 0x11]);
}

#[test]
fn payload_window_to_is_u32_little_endian_at_79() {
    let payload = build_payload(&fields());
    assert_eq!(&payload[79..83], &[0x88, 0x77, 0x66, 0x55]);
}

#[test]
fn payload_windows_at_u32_max_fill_four_ff_bytes() {
    let payload = build_payload(&PayloadFields {
        window_from: u32::MAX,
        window_to: u32::MAX,
        ..fields()
    });
    assert_eq!(&payload[75..83], &[0xFF; 8]);
}

#[test]
fn payload_windows_at_zero_are_zero_bytes() {
    let payload = build_payload(&PayloadFields {
        window_from: 0,
        window_to: 0,
        ..fields()
    });
    assert_eq!(&payload[75..83], &[0; 8]);
}

#[test]
fn payload_is_deterministic() {
    assert_eq!(build_payload(&fields()), build_payload(&fields()));
}

// --- message -----------------------------------------------------------

const EXPIRY: i64 = 0x1112_1314_1516_1718;

/// The §8 layout, hand-assembled for `context()`, `WALLET`, `fields()`.
fn expected_message(expiry_le: [u8; 8]) -> Vec<u8> {
    let mut out = b"TIO-ATTEST-v1".to_vec();
    out.extend_from_slice(&[0x11; 32]);
    out.extend_from_slice(&[0x22; 32]);
    out.extend_from_slice(&[0x33; 32]);
    out.extend_from_slice(&[0x44; 32]);
    out.extend_from_slice(&expected_payload());
    out.extend_from_slice(&expiry_le);
    out
}

fn message(expiry: i64) -> [u8; MESSAGE_LEN] {
    build_message(&context(), &WALLET, &build_payload(&fields()), expiry)
}

#[test]
fn message_matches_the_hand_assembled_layout() {
    let msg = message(EXPIRY);
    assert_eq!(msg.len(), 232);
    assert_eq!(
        msg.as_slice(),
        expected_message([0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11]).as_slice()
    );
}

#[test]
fn message_starts_with_the_domain_tag() {
    assert_eq!(&message(EXPIRY)[0..13], b"TIO-ATTEST-v1");
}

#[test]
fn message_oracle_program_id_occupies_13_to_45() {
    assert_eq!(&message(EXPIRY)[13..45], &[0x11; 32]);
}

#[test]
fn message_sas_credential_occupies_45_to_77() {
    assert_eq!(&message(EXPIRY)[45..77], &[0x22; 32]);
}

#[test]
fn message_sas_schema_occupies_77_to_109() {
    assert_eq!(&message(EXPIRY)[77..109], &[0x33; 32]);
}

#[test]
fn message_wallet_occupies_109_to_141() {
    assert_eq!(&message(EXPIRY)[109..141], &[0x44; 32]);
}

#[test]
fn message_payload_occupies_141_to_224() {
    assert_eq!(&message(EXPIRY)[141..224], expected_payload().as_slice());
}

#[test]
fn message_expiry_is_i64_little_endian_at_224() {
    assert_eq!(
        &message(EXPIRY)[224..232],
        &[0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11]
    );
}

#[test]
fn message_negative_expiry_is_twos_complement_little_endian() {
    assert_eq!(&message(-1)[224..232], &[0xFF; 8]);
}

#[test]
fn message_ignores_context_proof_type_and_measurement_id() {
    // Those travel inside the payload (built from PayloadFields), not as
    // separate message fields (§8).
    let other = AttestContext {
        measurement_id: 0x99,
        ..context()
    };
    let payload = build_payload(&fields());
    assert_eq!(
        build_message(&other, &WALLET, &payload, EXPIRY),
        build_message(&context(), &WALLET, &payload, EXPIRY)
    );
}

#[test]
fn message_changes_when_the_wallet_changes() {
    let payload = build_payload(&fields());
    let a = build_message(&context(), &WALLET, &payload, EXPIRY);
    let b = build_message(&context(), &[0x45; 32], &payload, EXPIRY);
    assert_ne!(a, b);
    assert_eq!(&b[109..141], &[0x45; 32]);
}
