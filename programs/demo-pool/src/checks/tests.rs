//! Unit tests for the pool's lending rules (written in the red phase).

use super::*;

const NOW: i64 = 1_800_000_000;
const MAX_AGE: u32 = 3_600;
const MAX_WINDOW_AGE: u32 = 86_400;
const MIN_WINDOW: u32 = 600;
/// A window end 100 s before an `issued_at` of `NOW - 10`: recent enough for
/// the window-age rule, so only the window length is under test.
const RECENT_WINDOW_TO: u32 = 1_799_999_890;

// --- fixtures ---

fn params_with_limits(tier_limits: [u64; 3]) -> PoolParams {
    PoolParams {
        policy_hash: [7; 32],
        tier_limits,
        max_age_secs: MAX_AGE,
        max_window_age_secs: MAX_WINDOW_AGE,
        min_window_secs: MIN_WINDOW,
        approved_measurements: [0; 32],
    }
}

fn params() -> PoolParams {
    params_with_limits([1_000, 500, 100])
}

fn header_raw(issued_at: i64, window_from: u32, window_to: u32) -> PayloadHeader {
    PayloadHeader {
        tier: 1,
        proof_type: 1,
        measurement_id: 0,
        policy_hash: [9; 32],
        issued_at,
        window_from,
        window_to,
    }
}

/// A header that is `age` seconds old at `NOW`, whose window ended
/// `window_age` seconds before `issued_at` and lasted `window_len` seconds.
fn header(age: i64, window_age: i64, window_len: i64) -> PayloadHeader {
    let issued_at = NOW - age;
    let window_to = u32::try_from(issued_at - window_age).expect("fits u32");
    let window_from = u32::try_from(i64::from(window_to) - window_len).expect("fits u32");
    header_raw(issued_at, window_from, window_to)
}

/// Passes every rule with room to spare.
fn fresh() -> PayloadHeader {
    header(10, 100, 1_000)
}

/// `PoolError` may not implement `PartialEq`, so compare by error code.
fn is<T>(result: Result<T, PoolError>, expected: PoolError) -> bool {
    matches!(result, Err(e) if e as u32 == expected as u32)
}

// --- check_params ---

#[test]
fn check_params_accepts_strictly_descending_limits() {
    assert!(check_params(&params_with_limits([300, 200, 100])).is_ok());
}

#[test]
fn check_params_accepts_equal_limits() {
    assert!(check_params(&params_with_limits([5, 5, 5])).is_ok());
}

#[test]
fn check_params_accepts_zero_b_and_c() {
    assert!(check_params(&params_with_limits([5, 0, 0])).is_ok());
}

#[test]
fn check_params_accepts_zero_c_only() {
    assert!(check_params(&params_with_limits([5, 3, 0])).is_ok());
}

#[test]
fn check_params_rejects_zero_a() {
    assert!(is(
        check_params(&params_with_limits([0, 0, 0])),
        PoolError::InvalidTierLimits
    ));
}

#[test]
fn check_params_rejects_a_below_b() {
    assert!(is(
        check_params(&params_with_limits([4, 5, 1])),
        PoolError::InvalidTierLimits
    ));
}

#[test]
fn check_params_rejects_b_below_c() {
    assert!(is(
        check_params(&params_with_limits([9, 4, 5])),
        PoolError::InvalidTierLimits
    ));
}

#[test]
fn check_params_rejects_c_above_zero_b() {
    assert!(is(
        check_params(&params_with_limits([9, 0, 1])),
        PoolError::InvalidTierLimits
    ));
}

#[test]
fn check_params_does_not_validate_other_fields() {
    let mut p = params();
    p.max_age_secs = 0;
    p.max_window_age_secs = 0;
    p.min_window_secs = 0;
    p.policy_hash = [0; 32];
    p.approved_measurements = [0; 32];
    assert!(check_params(&p).is_ok());
}

// --- tier_limit ---

#[test]
fn tier_limit_maps_tiers_1_2_3_to_a_b_c() {
    let limits = [30u64, 20, 10];
    assert_eq!(tier_limit(&limits, 1).expect("tier A"), 30);
    assert_eq!(tier_limit(&limits, 2).expect("tier B"), 20);
    assert_eq!(tier_limit(&limits, 3).expect("tier C"), 10);
}

#[test]
fn tier_limit_rejects_tier_0() {
    assert!(is(tier_limit(&[30, 20, 10], 0), PoolError::TierNotAccepted));
}

#[test]
fn tier_limit_rejects_tier_4() {
    assert!(is(tier_limit(&[30, 20, 10], 4), PoolError::TierNotAccepted));
}

#[test]
fn tier_limit_rejects_tier_255() {
    assert!(is(
        tier_limit(&[30, 20, 10], 255),
        PoolError::TierNotAccepted
    ));
}

#[test]
fn tier_limit_rejects_tier_with_zero_limit() {
    let limits = [30u64, 0, 0];
    assert!(is(tier_limit(&limits, 2), PoolError::TierNotAccepted));
    assert!(is(tier_limit(&limits, 3), PoolError::TierNotAccepted));
}

#[test]
fn tier_limit_still_accepts_a_when_only_a_is_lendable() {
    assert_eq!(tier_limit(&[30, 0, 0], 1).expect("tier A"), 30);
}

// --- is_approved ---

fn bitmap_with(id: u8) -> [u8; 32] {
    let mut bitmap = [0u8; 32];
    bitmap[usize::from(id / 8)] |= 1 << (id % 8);
    bitmap
}

#[test]
fn is_approved_is_false_for_every_id_in_an_empty_bitmap() {
    for id in 0..=255u8 {
        assert!(!is_approved(&[0; 32], id), "id {id}");
    }
}

#[test]
fn is_approved_reads_id_0_as_least_significant_bit_of_byte_0() {
    let mut bitmap = [0u8; 32];
    bitmap[0] = 0b0000_0001;
    assert!(is_approved(&bitmap, 0));
}

#[test]
fn is_approved_reads_id_7_as_most_significant_bit_of_byte_0() {
    let mut bitmap = [0u8; 32];
    bitmap[0] = 0b1000_0000;
    assert!(is_approved(&bitmap, 7));
}

#[test]
fn is_approved_reads_id_8_from_byte_1() {
    let mut bitmap = [0u8; 32];
    bitmap[1] = 0b0000_0001;
    assert!(is_approved(&bitmap, 8));
}

#[test]
fn is_approved_reads_id_254_and_255_from_byte_31() {
    let mut bitmap = [0u8; 32];
    bitmap[31] = 0b0100_0000;
    assert!(is_approved(&bitmap, 254));
    assert!(!is_approved(&bitmap, 255));
    bitmap[31] = 0b1000_0000;
    assert!(is_approved(&bitmap, 255));
    assert!(!is_approved(&bitmap, 254));
}

#[test]
fn is_approved_does_not_approve_a_neighbour_of_a_set_bit() {
    let bitmap = bitmap_with(8);
    assert!(is_approved(&bitmap, 8));
    assert!(!is_approved(&bitmap, 7));
    assert!(!is_approved(&bitmap, 9));
    assert!(!is_approved(&bitmap, 0));
}

#[test]
fn is_approved_setting_one_bit_approves_only_that_id() {
    for set in 0..=255u8 {
        let bitmap = bitmap_with(set);
        for id in 0..=255u8 {
            assert_eq!(is_approved(&bitmap, id), id == set, "set {set}, id {id}");
        }
    }
}

#[test]
fn is_approved_is_true_for_every_id_in_a_full_bitmap() {
    for id in 0..=255u8 {
        assert!(is_approved(&[0xFF; 32], id), "id {id}");
    }
}

// --- check_expiry ---

#[test]
fn check_expiry_accepts_one_second_before_expiry() {
    assert!(check_expiry(NOW, NOW + 1).is_ok());
}

#[test]
fn check_expiry_rejects_now_equal_to_expiry() {
    assert!(is(check_expiry(NOW, NOW), PoolError::AttestationExpired));
}

#[test]
fn check_expiry_rejects_expiry_in_the_past() {
    assert!(is(
        check_expiry(NOW, NOW - 1),
        PoolError::AttestationExpired
    ));
}

#[test]
fn check_expiry_rejects_zero_never_expires_marker() {
    assert!(is(check_expiry(NOW, 0), PoolError::AttestationExpired));
}

#[test]
fn check_expiry_rejects_zero_expiry_even_when_now_is_negative() {
    assert!(is(check_expiry(-5, 0), PoolError::AttestationExpired));
}

#[test]
fn check_expiry_accepts_the_largest_expiry() {
    assert!(check_expiry(NOW, i64::MAX).is_ok());
}

// --- check_freshness ---

#[test]
fn check_freshness_accepts_a_fresh_payload() {
    assert!(check_freshness(&params(), NOW, &fresh()).is_ok());
}

#[test]
fn check_freshness_accepts_age_exactly_at_the_limit() {
    let h = header(i64::from(MAX_AGE), 100, 1_000);
    assert!(check_freshness(&params(), NOW, &h).is_ok());
}

#[test]
fn check_freshness_rejects_age_one_second_over_the_limit() {
    let h = header(i64::from(MAX_AGE) + 1, 100, 1_000);
    assert!(is(
        check_freshness(&params(), NOW, &h),
        PoolError::AttestationTooOld
    ));
}

#[test]
fn check_freshness_accepts_issued_at_after_now() {
    let h = header(-120, 100, 1_000);
    assert!(check_freshness(&params(), NOW, &h).is_ok());
}

#[test]
fn check_freshness_accepts_window_age_exactly_at_the_limit() {
    let h = header(10, i64::from(MAX_WINDOW_AGE), 1_000);
    assert!(check_freshness(&params(), NOW, &h).is_ok());
}

#[test]
fn check_freshness_rejects_window_age_one_second_over_the_limit() {
    let h = header(10, i64::from(MAX_WINDOW_AGE) + 1, 1_000);
    assert!(is(
        check_freshness(&params(), NOW, &h),
        PoolError::WindowTooOld
    ));
}

#[test]
fn check_freshness_accepts_window_ending_after_issued_at() {
    let h = header(10, -500, 1_000);
    assert!(check_freshness(&params(), NOW, &h).is_ok());
}

#[test]
fn check_freshness_accepts_window_length_exactly_at_the_minimum() {
    let h = header(10, 100, i64::from(MIN_WINDOW));
    assert!(check_freshness(&params(), NOW, &h).is_ok());
}

#[test]
fn check_freshness_rejects_window_length_one_second_under_the_minimum() {
    let h = header(10, 100, i64::from(MIN_WINDOW) - 1);
    assert!(is(
        check_freshness(&params(), NOW, &h),
        PoolError::WindowTooShort
    ));
}

#[test]
fn check_freshness_rejects_window_ending_before_it_starts() {
    let h = header_raw(NOW - 10, RECENT_WINDOW_TO + 1_000, RECENT_WINDOW_TO);
    assert!(is(
        check_freshness(&params(), NOW, &h),
        PoolError::WindowTooShort
    ));
}

#[test]
fn check_freshness_rejects_backwards_window_when_minimum_is_zero() {
    let mut p = params();
    p.min_window_secs = 0;
    let h = header_raw(NOW - 10, RECENT_WINDOW_TO + 1, RECENT_WINDOW_TO);
    assert!(is(check_freshness(&p, NOW, &h), PoolError::WindowTooShort));
}

#[test]
fn check_freshness_accepts_empty_window_when_minimum_is_zero() {
    let mut p = params();
    p.min_window_secs = 0;
    let h = header_raw(NOW - 10, RECENT_WINDOW_TO, RECENT_WINDOW_TO);
    assert!(check_freshness(&p, NOW, &h).is_ok());
}

#[test]
fn check_freshness_reports_age_before_window_age() {
    let h = header(i64::from(MAX_AGE) + 1, i64::from(MAX_WINDOW_AGE) + 1, 1_000);
    assert!(is(
        check_freshness(&params(), NOW, &h),
        PoolError::AttestationTooOld
    ));
}

#[test]
fn check_freshness_reports_window_age_before_window_length() {
    let h = header(10, i64::from(MAX_WINDOW_AGE) + 1, i64::from(MIN_WINDOW) - 1);
    assert!(is(
        check_freshness(&params(), NOW, &h),
        PoolError::WindowTooOld
    ));
}

#[test]
fn check_freshness_reports_age_before_window_length() {
    let h = header(i64::from(MAX_AGE) + 1, 100, i64::from(MIN_WINDOW) - 1);
    assert!(is(
        check_freshness(&params(), NOW, &h),
        PoolError::AttestationTooOld
    ));
}

#[test]
fn check_freshness_fails_closed_when_age_overflows() {
    let h = header_raw(i64::MIN, 0, 0);
    assert!(is(
        check_freshness(&params(), i64::MAX, &h),
        PoolError::AttestationTooOld
    ));
}

#[test]
fn check_freshness_fails_closed_when_window_age_overflows() {
    // now == issued_at, so rule 1 passes; `i64::MIN - window_to` overflows.
    let h = header_raw(i64::MIN, 0, u32::MAX);
    assert!(is(
        check_freshness(&params(), i64::MIN, &h),
        PoolError::WindowTooOld
    ));
}

#[test]
fn check_freshness_ignores_tier_proof_type_measurement_and_policy() {
    let mut h = fresh();
    h.tier = 0;
    h.proof_type = 255;
    h.measurement_id = 255;
    h.policy_hash = [0xAB; 32];
    assert!(check_freshness(&params(), NOW, &h).is_ok());
}
