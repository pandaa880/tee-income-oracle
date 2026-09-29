#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use super::*;

#[test]
fn format_iso_utc_epoch_zero() {
    assert_eq!(format_iso_utc(0), "1970-01-01T00:00:00.000Z");
}

#[test]
fn format_iso_utc_leap_day_2024() {
    // 2024-02-29T00:00:00Z (computed with Python's stdlib datetime, UTC).
    assert_eq!(format_iso_utc(1_709_164_800), "2024-02-29T00:00:00.000Z");
}

#[test]
fn format_iso_utc_known_timestamp_2026_09_26() {
    // 2026-09-26T10:00:00Z, the `docs/FORMATS.md` §3 example `expiry`.
    assert_eq!(format_iso_utc(1_790_416_800), "2026-09-26T10:00:00.000Z");
}

#[test]
fn format_iso_utc_one_second_before_epoch() {
    assert_eq!(format_iso_utc(-1), "1969-12-31T23:59:59.000Z");
}

#[test]
fn format_iso_utc_year_2100() {
    // 2100-01-01T00:00:00Z: 2100 is not a leap year (divisible by 100, not 400).
    assert_eq!(format_iso_utc(4_102_444_800), "2100-01-01T00:00:00.000Z");
}
