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

// Unix seconds below were computed with Python's stdlib datetime (UTC):
// 2026-04-01T09:12:00Z = 1_775_034_720.
const APRIL_1_0912_UTC: i64 = 1_775_034_720;

#[test]
fn parse_rebit_timestamp_accepts_each_written_form() {
    let cases: &[(&str, i64)] = &[
        ("2026-04-01T09:12:00Z", APRIL_1_0912_UTC),
        ("2026-04-01T09:12:00.000Z", APRIL_1_0912_UTC),
        ("2026-04-01T09:12:00+0000", APRIL_1_0912_UTC),
        ("2026-04-01T09:12:00+00:00", APRIL_1_0912_UTC),
        ("2026-04-01T09:12:00-0000", APRIL_1_0912_UTC),
        ("2026-04-01T09:12:00", APRIL_1_0912_UTC),
        ("2026-04-01T09:12:00.000", APRIL_1_0912_UTC),
        // 09:12 at +05:30 is 03:42 UTC.
        ("2026-04-01T09:12:00.000+0530", 1_775_014_920),
        ("2026-04-01T09:12:00+05:30", 1_775_014_920),
        // 09:12 at -08:00 is 17:12 UTC.
        ("2026-04-01T09:12:00-0800", 1_775_063_520),
        ("2026-04-01T09:12:00-08:00", 1_775_063_520),
        ("1970-01-01T00:00:00Z", 0),
        ("1970-01-01T00:00:00", 0),
        // 2024-02-29T12:30:45Z, a leap day.
        ("2024-02-29T12:30:45Z", 1_709_209_845),
        // 2100-01-01T00:00:00Z.
        ("2100-01-01T00:00:00Z", 4_102_444_800),
    ];
    for (input, expected) in cases {
        assert_eq!(
            parse_rebit_timestamp(input),
            Ok(*expected),
            "input {input:?}"
        );
    }
}

#[test]
fn parse_rebit_timestamp_offset_can_cross_the_epoch() {
    // 1970-01-01T00:00:00+05:30 is 1969-12-31T18:30:00Z.
    assert_eq!(
        parse_rebit_timestamp("1970-01-01T00:00:00+05:30"),
        Ok(-19_800)
    );
}

#[test]
fn parse_rebit_timestamp_truncates_fractions_of_one_to_nine_digits() {
    for digits in 1..=9usize {
        let input = format!("2026-04-01T09:12:00.{}Z", "9".repeat(digits));
        assert_eq!(
            parse_rebit_timestamp(&input),
            Ok(APRIL_1_0912_UTC),
            "input {input:?}"
        );
    }
}

#[test]
fn parse_rebit_timestamp_rejects_malformed_or_nonexistent_values() {
    let cases = [
        "2026-02-30T00:00:00Z",
        "2025-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-00-01T00:00:00Z",
        "2026-01-00T00:00:00Z",
        "2026-01-32T00:00:00Z",
        "2026-04-01T24:00:00Z",
        "2026-04-01T12:60:00Z",
        "2026-04-01T12:00:60Z",
        "2026-04-01T12:00:00+2400",
        "2026-04-01T12:00:00+0560",
        "2026-04-01T12:00:00+0530x",
        "2026-04-01T12:00:00Zx",
        "2026-04-01T12:00:00z",
        "2026-04-01t12:00:00Z",
        "2026-04-01T12:00:00.1234567890Z",
        "2026-04-01T12:00:00.Z",
        "2026-04-01T12:00:00.",
        "2026-04-01 12:00:00Z",
        "2026-04-01T12:00Z",
        "2026-04-01T12:00",
        "2026-04-01T12:00:00+05",
        "2026-04-01T12:00:00+5:30",
        "2026-04-01",
        "2026-4-1T12:00:00Z",
        "26-04-01T12:00:00Z",
        " 2026-04-01T12:00:00Z",
        "2026-04-01T12:00:00Z ",
        // Arabic-Indic digits for 2026.
        "\u{0662}\u{0660}\u{0662}\u{0666}-04-01T12:00:00Z",
        // Fullwidth digits in the day.
        "2026-04-\u{FF10}\u{FF11}T12:00:00Z",
        "",
    ];
    for input in cases {
        assert_eq!(
            parse_rebit_timestamp(input),
            Err(TimeError),
            "input {input:?}"
        );
    }
}

#[test]
fn parse_date_accepts_a_plain_date() {
    // Days since epoch computed with Python: (date - date(1970,1,1)).days.
    let cases: &[(&str, i64)] = &[
        ("1970-01-01", 0),
        ("2026-03-26", 20_538),
        ("2024-02-29", 19_782),
        ("2026-09-26", 20_722),
    ];
    for (input, expected) in cases {
        assert_eq!(parse_date(input), Ok(*expected), "input {input:?}");
    }
}

#[test]
fn parse_date_uses_the_written_date_of_a_full_timestamp() {
    // 23:30 at +05:30 is still 2026-03-26 as written (18:00Z the same day);
    // 00:30 at +05:30 would be the previous day in UTC but must not shift.
    let cases: &[(&str, i64)] = &[
        ("2026-03-26T23:30:00+05:30", 20_538),
        ("2026-03-26T00:30:00+05:30", 20_538),
        ("2026-03-26T23:30:00-0800", 20_538),
        ("2026-03-26T00:00:00.000Z", 20_538),
        ("2026-03-26T10:00:00", 20_538),
    ];
    for (input, expected) in cases {
        assert_eq!(parse_date(input), Ok(*expected), "input {input:?}");
    }
}

#[test]
fn parse_date_rejects_invalid_dates_and_invalid_datetime_tails() {
    let cases = [
        "2026-3-26",
        "2026-03-6",
        "2026-02-30",
        "2025-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-03-00",
        "2026/03/26",
        "20260326",
        "2026-03-26 ",
        "2026-03-26T",
        "2026-03-26T25:00:00Z",
        "2026-03-26T12:00:00+0530x",
        "2026-03-26T12:00",
        "2026-03-26x",
        "2026-02-30T12:00:00Z",
        "\u{0662}\u{0660}\u{0662}\u{0666}-03-26",
        "",
    ];
    for input in cases {
        assert_eq!(parse_date(input), Err(TimeError), "input {input:?}");
    }
}

#[test]
fn days_from_civil_known_values() {
    assert_eq!(days_from_civil(1970, 1, 1), 0);
    assert_eq!(days_from_civil(1969, 12, 31), -1);
    assert_eq!(days_from_civil(2024, 2, 29), 19_782);
    assert_eq!(days_from_civil(2026, 3, 26), 20_538);
    assert_eq!(days_from_civil(2100, 3, 1), 47_541);
    assert_eq!(days_from_civil(1969, 12, 1), -31);
}

#[test]
fn days_from_civil_inverts_civil_from_days_over_1969_to_2100() {
    // -31 is 1969-12-01 and 47_541 is 2100-03-01 (Python date arithmetic);
    // the span covers the epoch and the non-leap 2100.
    for days in -31..=47_541 {
        let (year, month, day) = civil_from_days(days);
        assert_eq!(
            days_from_civil(year, month, day),
            days,
            "days {days} = {year}-{month}-{day}"
        );
    }
}
