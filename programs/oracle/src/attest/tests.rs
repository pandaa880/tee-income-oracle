//! Unit tests for the precompile, message and clock rules (written in the red phase).

use anchor_lang::error::Error as AnchorError;

use super::*;
use crate::sas::{
    parse_attestation, stored_issued_at, ATTESTATION_ACCOUNT_LEN, ATTESTATION_DISCRIMINATOR,
    ATTESTATION_EXPIRY_OFFSET, ATTESTATION_SIGNER_OFFSET, SAS_PROGRAM_ID, STORED_ISSUED_AT_OFFSET,
};

const INDEX: u8 = 3;

// --- fixtures ---

/// A well-formed 329-byte precompile instruction for `index`, with recognisable
/// bytes in the address, signature, recovery id and message regions. The offsets
/// are spelled out by hand so this fixture doesn't depend on `expected_offsets`.
fn precompile(index: u8) -> Vec<u8> {
    let mut data = vec![0u8; PRECOMPILE_DATA_LEN];
    data[0] = 1;
    data[1..12].copy_from_slice(&[32, 0, index, 12, 0, index, 97, 0, 232, 0, index]);
    data[12..32].fill(0xE0);
    data[32..96].fill(0x5A);
    data[96] = 1;
    for (byte, value) in data[97..329].iter_mut().zip((0..251u8).cycle()) {
        *byte = value;
    }
    data
}

fn message() -> [u8; MESSAGE_LEN] {
    let mut m = [0u8; MESSAGE_LEN];
    m[..13].copy_from_slice(DOMAIN_TAG);
    m[13..45].fill(1); // program id
    m[45..77].fill(2); // credential
    m[77..109].fill(3); // schema
    m[109..141].fill(4); // wallet
    for (byte, value) in m[141..224].iter_mut().zip(0x80u8..) {
        *byte = value; // payload
    }
    m[224..232].copy_from_slice(&0x0102_0304_0506_0708i64.to_le_bytes());
    m
}

fn payload(tier: u8, proof: u8, id: u8, issued_at: i64) -> [u8; PAYLOAD_LEN] {
    let mut p = [0xFFu8; PAYLOAD_LEN];
    p[0] = tier;
    p[1] = proof;
    p[2] = id;
    p[67..75].copy_from_slice(&issued_at.to_le_bytes());
    p
}

/// `OracleError` may not implement `PartialEq`, so compare by error code.
fn is<T>(result: Result<T, OracleError>, expected: OracleError) -> bool {
    matches!(result, Err(e) if e as u32 == expected as u32)
}

// --- expected_offsets ---

#[test]
fn expected_offsets_for_index_zero() {
    assert_eq!(expected_offsets(0), [32, 0, 0, 12, 0, 0, 97, 0, 232, 0, 0]);
}

#[test]
fn expected_offsets_for_index_three() {
    assert_eq!(expected_offsets(3), [32, 0, 3, 12, 0, 3, 97, 0, 232, 0, 3]);
}

#[test]
fn expected_offsets_for_index_255() {
    assert_eq!(
        expected_offsets(255),
        [32, 0, 255, 12, 0, 255, 97, 0, 232, 0, 255]
    );
}

// --- parse_precompile ---

#[test]
fn parse_precompile_returns_attester_and_message_slices() {
    let data = precompile(INDEX);
    let verified = parse_precompile(&data, INDEX).expect("well-formed layout");
    assert_eq!(verified.attester, &[0xE0u8; 20]);
    assert_eq!(verified.message.as_slice(), &data[97..329]);
}

#[test]
fn parse_precompile_accepts_index_zero_and_255() {
    for index in [0u8, 255] {
        assert!(parse_precompile(&precompile(index), index).is_ok());
    }
}

#[test]
fn parse_precompile_rejects_length_328() {
    let mut data = precompile(INDEX);
    data.pop();
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_length_330() {
    let mut data = precompile(INDEX);
    data.push(0);
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_empty_data() {
    assert!(is(
        parse_precompile(&[], INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_signature_count_zero() {
    let mut data = precompile(INDEX);
    data[0] = 0;
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_signature_count_two() {
    let mut data = precompile(INDEX);
    data[0] = 2;
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_each_offset_byte_off_by_one() {
    for position in 1..=OFFSETS_LEN {
        let mut data = precompile(INDEX);
        data[position] = data[position].wrapping_add(1);
        assert!(
            is(
                parse_precompile(&data, INDEX),
                OracleError::InvalidPrecompileLayout
            ),
            "offset byte {position} off by one must be rejected",
        );
    }
}

#[test]
fn parse_precompile_rejects_signature_offset_wrong() {
    let mut data = precompile(INDEX);
    data[1] = 33;
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_eth_address_offset_wrong() {
    let mut data = precompile(INDEX);
    data[4] = 13;
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_message_offset_wrong() {
    let mut data = precompile(INDEX);
    data[7] = 98;
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_message_size_wrong() {
    let mut data = precompile(INDEX);
    data[9] = 231;
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_signature_instruction_index_pointing_elsewhere() {
    let mut data = precompile(INDEX);
    data[3] = INDEX - 1;
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_eth_instruction_index_pointing_elsewhere() {
    let mut data = precompile(INDEX);
    data[6] = INDEX - 1;
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_message_instruction_index_pointing_elsewhere() {
    let mut data = precompile(INDEX);
    data[11] = INDEX - 1;
    assert!(is(
        parse_precompile(&data, INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

#[test]
fn parse_precompile_rejects_layout_built_for_another_index() {
    assert!(is(
        parse_precompile(&precompile(INDEX + 1), INDEX),
        OracleError::InvalidPrecompileLayout
    ));
}

// --- parse_message ---

#[test]
fn parse_message_splits_every_field() {
    let m = message();
    let parsed = parse_message(&m).expect("valid message");
    assert_eq!(parsed.program_id, Pubkey::new_from_array([1; 32]));
    assert_eq!(parsed.credential, Pubkey::new_from_array([2; 32]));
    assert_eq!(parsed.schema, Pubkey::new_from_array([3; 32]));
    assert_eq!(parsed.wallet, Pubkey::new_from_array([4; 32]));
    assert_eq!(parsed.payload.as_slice(), &m[141..224]);
    assert_eq!(parsed.expiry, 0x0102_0304_0506_0708);
}

#[test]
fn parse_message_reads_negative_expiry() {
    let mut m = message();
    m[224..232].copy_from_slice(&(-42i64).to_le_bytes());
    assert_eq!(parse_message(&m).expect("valid message").expiry, -42);
}

#[test]
fn parse_message_rejects_wrong_first_tag_byte() {
    let mut m = message();
    m[0] ^= 1;
    assert!(is(parse_message(&m), OracleError::WrongDomainTag));
}

#[test]
fn parse_message_rejects_wrong_last_tag_byte() {
    let mut m = message();
    m[12] ^= 1;
    assert!(is(parse_message(&m), OracleError::WrongDomainTag));
}

#[test]
fn parse_message_accepts_any_byte_right_after_the_tag() {
    let mut m = message();
    m[13] = 0;
    assert!(parse_message(&m).is_ok());
}

// --- parse_payload ---

#[test]
fn parse_payload_reads_tier_proof_type_and_measurement_id() {
    let header = parse_payload(&payload(2, 1, 7, 0));
    assert_eq!(
        (header.tier, header.proof_type, header.measurement_id),
        (2, 1, 7)
    );
}

#[test]
fn parse_payload_reads_issued_at_little_endian_at_offset_67() {
    let header = parse_payload(&payload(1, 1, 0, 0x0102_0304_0506_0708));
    assert_eq!(header.issued_at, 0x0102_0304_0506_0708);
}

#[test]
fn parse_payload_reads_negative_issued_at() {
    assert_eq!(parse_payload(&payload(1, 1, 0, -1)).issued_at, -1);
}

#[test]
fn parse_payload_does_not_read_issued_at_from_neighbouring_bytes() {
    let mut p = payload(1, 1, 0, 1_000);
    p[66] = 0x11;
    p[75] = 0x22;
    assert_eq!(parse_payload(&p).issued_at, 1_000);
}

// --- check_tier ---

#[test]
fn check_tier_accepts_1_2_3() {
    for tier in [1u8, 2, 3] {
        assert!(check_tier(tier).is_ok(), "tier {tier}");
    }
}

#[test]
fn check_tier_rejects_0_4_and_255() {
    for tier in [0u8, 4, 255] {
        assert!(
            is(check_tier(tier), OracleError::InvalidTier),
            "tier {tier}"
        );
    }
}

// --- check_times ---

const NOW: i64 = 1_000_000;

#[test]
fn check_times_accepts_issued_at_exactly_now_plus_300() {
    let issued = NOW + MAX_SKEW_SECS;
    assert!(check_times(NOW, issued, issued + 600).is_ok());
}

#[test]
fn check_times_rejects_issued_at_now_plus_301() {
    let issued = NOW + MAX_SKEW_SECS + 1;
    assert!(is(
        check_times(NOW, issued, issued + 600),
        OracleError::IssuedInFuture
    ));
}

#[test]
fn check_times_accepts_expiry_exactly_now() {
    assert!(check_times(NOW, NOW - 100, NOW).is_ok());
}

#[test]
fn check_times_rejects_expiry_one_second_before_now() {
    assert!(is(
        check_times(NOW, NOW - 100, NOW - 1),
        OracleError::SignatureExpired
    ));
}

#[test]
fn check_times_accepts_lifetime_exactly_600() {
    let issued = NOW - 10;
    assert!(check_times(NOW, issued, issued + 600).is_ok());
}

#[test]
fn check_times_rejects_lifetime_601() {
    let issued = NOW - 10;
    assert!(is(
        check_times(NOW, issued, issued + 601),
        OracleError::ExpiryTooFar
    ));
}

#[test]
fn check_times_accepts_lifetime_of_one_second() {
    assert!(check_times(NOW, NOW, NOW + 1).is_ok());
}

#[test]
fn check_times_rejects_expiry_equal_to_issued_at() {
    assert!(is(check_times(NOW, NOW, NOW), OracleError::ExpiryTooFar));
}

#[test]
fn check_times_rejects_expiry_before_issued_at() {
    assert!(is(
        check_times(NOW, NOW + 10, NOW + 5),
        OracleError::ExpiryTooFar
    ));
}

#[test]
fn check_times_reports_future_before_expired() {
    let issued = NOW + MAX_SKEW_SECS + 1;
    assert!(is(
        check_times(NOW, issued, NOW - 1),
        OracleError::IssuedInFuture
    ));
}

#[test]
fn check_times_reports_future_before_too_far() {
    let issued = NOW + MAX_SKEW_SECS + 1;
    assert!(is(
        check_times(NOW, issued, issued + 601),
        OracleError::IssuedInFuture
    ));
}

#[test]
fn check_times_reports_expired_before_too_far() {
    // Lifetime 999 (too far) and already expired: expired wins.
    assert!(is(
        check_times(NOW, NOW - 1_000, NOW - 1),
        OracleError::SignatureExpired
    ));
}

#[test]
fn check_times_does_not_overflow_on_extreme_values() {
    assert!(check_times(i64::MAX, i64::MAX, i64::MAX).is_err());
    assert!(check_times(0, i64::MIN, i64::MAX).is_err());
    assert!(check_times(i64::MIN, i64::MIN, i64::MAX).is_err());
}

// --- sas_expiry ---

#[test]
fn sas_expiry_is_issued_at_plus_thirty_days() {
    assert_eq!(sas_expiry(1_000).expect("no overflow"), 1_000 + 30 * 86_400);
}

#[test]
fn sas_expiry_accepts_the_largest_issued_at_that_fits() {
    let issued = i64::MAX - ATTESTATION_TTL_SECS;
    assert_eq!(sas_expiry(issued).expect("fits"), i64::MAX);
}

#[test]
fn sas_expiry_overflow_is_issued_in_future() {
    assert!(is(sas_expiry(i64::MAX), OracleError::IssuedInFuture));
    assert!(is(
        sas_expiry(i64::MAX - ATTESTATION_TTL_SECS + 1),
        OracleError::IssuedInFuture
    ));
}

// --- sas::stored_issued_at ---

fn sas_account(issued_at: i64) -> Vec<u8> {
    let mut data = vec![0u8; ATTESTATION_ACCOUNT_LEN];
    data[0] = ATTESTATION_DISCRIMINATOR;
    data[STORED_ISSUED_AT_OFFSET..STORED_ISSUED_AT_OFFSET + 8]
        .copy_from_slice(&issued_at.to_le_bytes());
    data
}

fn is_invalid_existing(result: anchor_lang::Result<i64>) -> bool {
    matches!(
        result,
        Err(AnchorError::AnchorError(e))
            if e.error_code_number == 6000 + OracleError::InvalidExistingAttestation as u32
    )
}

#[test]
fn error_code_of_invalid_existing_attestation_is_6027() {
    assert_eq!(6000 + OracleError::InvalidExistingAttestation as u32, 6027);
}

#[test]
fn stored_issued_at_layout_constants_match_the_sas_account() {
    assert_eq!(ATTESTATION_ACCOUNT_LEN, 256);
    assert_eq!(ATTESTATION_DISCRIMINATOR, 2);
    assert_eq!(STORED_ISSUED_AT_OFFSET, 168);
}

#[test]
fn stored_issued_at_reads_the_value_at_byte_168() {
    let data = sas_account(1_790_416_800);
    assert_eq!(data[168..176], 1_790_416_800i64.to_le_bytes());
    assert_eq!(
        stored_issued_at(&SAS_PROGRAM_ID, &data).expect("valid"),
        1_790_416_800
    );
}

#[test]
fn stored_issued_at_reads_negative_values() {
    let data = sas_account(-9);
    assert_eq!(stored_issued_at(&SAS_PROGRAM_ID, &data).expect("valid"), -9);
}

#[test]
fn stored_issued_at_rejects_wrong_owner() {
    let data = sas_account(5);
    assert!(is_invalid_existing(stored_issued_at(
        &Pubkey::new_unique(),
        &data
    )));
}

#[test]
fn stored_issued_at_rejects_system_program_owner() {
    let data = sas_account(5);
    assert!(is_invalid_existing(stored_issued_at(
        &anchor_lang::system_program::ID,
        &data
    )));
}

#[test]
fn stored_issued_at_rejects_length_255() {
    let mut data = sas_account(5);
    data.pop();
    assert!(is_invalid_existing(stored_issued_at(
        &SAS_PROGRAM_ID,
        &data
    )));
}

#[test]
fn stored_issued_at_rejects_length_257() {
    let mut data = sas_account(5);
    data.push(0);
    assert!(is_invalid_existing(stored_issued_at(
        &SAS_PROGRAM_ID,
        &data
    )));
}

#[test]
fn stored_issued_at_rejects_empty_data() {
    assert!(is_invalid_existing(stored_issued_at(&SAS_PROGRAM_ID, &[])));
}

#[test]
fn stored_issued_at_rejects_discriminator_1() {
    let mut data = sas_account(5);
    data[0] = 1;
    assert!(is_invalid_existing(stored_issued_at(
        &SAS_PROGRAM_ID,
        &data
    )));
}

// --- parse_payload: policy hash and statement window ---

/// Every region gets its own recognisable bytes so a swapped offset shows.
fn full_payload() -> [u8; PAYLOAD_LEN] {
    let mut p = [0u8; PAYLOAD_LEN];
    p[0] = 2; // tier
    p[1] = 1; // proof type
    p[2] = 9; // measurement id
    p[3..35].fill(0xA1); // policy hash
    p[35..67].fill(0xC2); // consent hash
    p[67..75].copy_from_slice(&0x1122_3344_5566_7788i64.to_le_bytes());
    p[75..79].copy_from_slice(&0x0A0B_0C0Du32.to_le_bytes());
    p[79..83].copy_from_slice(&0x0E0F_1011u32.to_le_bytes());
    p
}

#[test]
fn parse_payload_reads_policy_hash_from_bytes_3_to_35() {
    let mut p = full_payload();
    for (byte, value) in p[3..35].iter_mut().zip(1u8..) {
        *byte = value;
    }
    let expected: [u8; 32] = core::array::from_fn(|i| u8::try_from(i + 1).expect("fits"));
    assert_eq!(parse_payload(&p).policy_hash, expected);
}

#[test]
fn parse_payload_reads_window_from_little_endian_at_offset_75() {
    assert_eq!(parse_payload(&full_payload()).window_from, 0x0A0B_0C0D);
}

#[test]
fn parse_payload_reads_window_to_little_endian_at_offset_79() {
    assert_eq!(parse_payload(&full_payload()).window_to, 0x0E0F_1011);
}

#[test]
fn parse_payload_reads_every_field_of_a_full_payload() {
    assert_eq!(
        parse_payload(&full_payload()),
        PayloadHeader {
            tier: 2,
            proof_type: 1,
            measurement_id: 9,
            policy_hash: [0xA1; 32],
            issued_at: 0x1122_3344_5566_7788,
            window_from: 0x0A0B_0C0D,
            window_to: 0x0E0F_1011,
        }
    );
}

#[test]
fn parse_payload_does_not_leak_consent_hash_into_any_field() {
    let mut p = full_payload();
    let before = parse_payload(&p);
    p[35..67].fill(0x5E);
    assert_eq!(parse_payload(&p), before);
}

#[test]
fn parse_payload_does_not_read_policy_hash_from_neighbouring_bytes() {
    let mut p = full_payload();
    p[2] = 0x77;
    p[35] = 0x77;
    assert_eq!(parse_payload(&p).policy_hash, [0xA1; 32]);
}

#[test]
fn parse_payload_does_not_read_window_from_neighbouring_bytes() {
    let mut p = full_payload();
    p[74] = 0x77;
    p[79] = 0x77;
    assert_eq!(parse_payload(&p).window_from, 0x0A0B_0C0D);
}

// --- sas::parse_attestation ---

/// A valid 256-byte SAS attestation with distinct bytes per region.
fn stored_attestation() -> Vec<u8> {
    let mut data = vec![0u8; ATTESTATION_ACCOUNT_LEN];
    data[0] = ATTESTATION_DISCRIMINATOR;
    data[1..33].fill(0x11); // nonce
    data[33..65].fill(0x22); // credential
    data[65..97].fill(0x33); // schema
    data[97..101].copy_from_slice(&83u32.to_le_bytes());
    for (byte, value) in data[101..184].iter_mut().zip(0x40u8..) {
        *byte = value; // payload
    }
    data[184..216].fill(0xBB); // signer
    data[216..224].copy_from_slice(&0x0102_0304_0506_0708i64.to_le_bytes());
    data[224..256].fill(0xEE); // token account
    data
}

#[test]
fn parse_attestation_layout_constants_match_the_sas_account() {
    assert_eq!(ATTESTATION_SIGNER_OFFSET, 184);
    assert_eq!(ATTESTATION_EXPIRY_OFFSET, 216);
}

#[test]
fn parse_attestation_returns_payload_signer_and_expiry() {
    let data = stored_attestation();
    let parsed = parse_attestation(&SAS_PROGRAM_ID, &data).expect("valid attestation");
    assert_eq!(parsed.payload.as_slice(), &data[101..184]);
    assert_eq!(parsed.signer, Pubkey::new_from_array([0xBB; 32]));
    assert_eq!(parsed.expiry, 0x0102_0304_0506_0708);
}

#[test]
fn parse_attestation_reads_negative_and_zero_expiry() {
    for expiry in [-7i64, 0] {
        let mut data = stored_attestation();
        data[216..224].copy_from_slice(&expiry.to_le_bytes());
        let parsed = parse_attestation(&SAS_PROGRAM_ID, &data).expect("valid attestation");
        assert_eq!(parsed.expiry, expiry);
    }
}

#[test]
fn parse_attestation_rejects_wrong_owner() {
    let data = stored_attestation();
    assert!(parse_attestation(&Pubkey::new_unique(), &data).is_none());
}

#[test]
fn parse_attestation_rejects_system_program_owner() {
    let data = stored_attestation();
    assert!(parse_attestation(&anchor_lang::system_program::ID, &data).is_none());
}

#[test]
fn parse_attestation_rejects_length_255() {
    let mut data = stored_attestation();
    data.pop();
    assert!(parse_attestation(&SAS_PROGRAM_ID, &data).is_none());
}

#[test]
fn parse_attestation_rejects_length_257() {
    let mut data = stored_attestation();
    data.push(0);
    assert!(parse_attestation(&SAS_PROGRAM_ID, &data).is_none());
}

#[test]
fn parse_attestation_rejects_discriminator_1() {
    let mut data = stored_attestation();
    data[0] = 1;
    assert!(parse_attestation(&SAS_PROGRAM_ID, &data).is_none());
}

#[test]
fn parse_attestation_rejects_discriminator_0() {
    let mut data = stored_attestation();
    data[0] = 0;
    assert!(parse_attestation(&SAS_PROGRAM_ID, &data).is_none());
}

#[test]
fn parse_attestation_rejects_empty_data() {
    assert!(parse_attestation(&SAS_PROGRAM_ID, &[]).is_none());
}
