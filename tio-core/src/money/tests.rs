#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use super::*;

const NN: Sign = Sign::NonNegative;
const ANY: Sign = Sign::Any;

fn paise(raw: &str, sign: Sign) -> Result<i64, MoneyError> {
    parse_paise(raw, sign).map(Paise::into_inner)
}

/// Mirrors `formatPaise` in `sandbox-bank/src/vectors/personas.ts`.
fn format_paise(paise: i64) -> String {
    let sign = if paise < 0 { "-" } else { "" };
    let abs = paise.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

fn assert_accepts(table: &[(&str, Sign, i64)]) {
    for (raw, sign, want) in table {
        assert_eq!(paise(raw, *sign), Ok(*want), "input {raw:?} ({sign:?})");
    }
}

fn assert_rejects(table: &[(&str, Sign, MoneyError)]) {
    for (raw, sign, want) in table {
        assert_eq!(paise(raw, *sign), Err(*want), "input {raw:?} ({sign:?})");
    }
}

// --- Paise basics ---

#[test]
fn paise_zero_is_zero() {
    assert_eq!(Paise::ZERO.into_inner(), 0);
    assert_eq!(Paise::default(), Paise::ZERO);
}

#[test]
fn paise_new_roundtrips_into_inner() {
    for v in [i64::MIN, -1, 0, 1, 12_345, i64::MAX] {
        assert_eq!(Paise::new(v).into_inner(), v);
    }
}

#[test]
fn paise_orders_by_value() {
    assert!(Paise::new(-1) < Paise::ZERO);
    assert!(Paise::new(2) > Paise::new(1));
}

// --- Error code ---

#[test]
fn every_money_error_maps_to_bad_fi_data() {
    for e in [
        MoneyError::BadFormat,
        MoneyError::NotWholePaise,
        MoneyError::Negative,
        MoneyError::Overflow,
    ] {
        assert_eq!(e.code(), "bad_fi_data", "{e:?}");
    }
}

// --- Accepted spellings ---

#[test]
fn accepts_plain_decimal_numbers() {
    assert_accepts(&[
        ("1234.05", NN, 123_405),
        ("0.07", NN, 7),
        ("5", NN, 500),
        ("85000.0", NN, 8_500_000),
        ("1234.050", NN, 123_405),
        ("1234.0500000000000000000000", NN, 123_405),
        ("0012.5", NN, 1_250),
        ("00000000000000000000005", NN, 500),
        ("0.5", NN, 50),
    ]);
}

#[test]
fn accepts_explicit_plus_and_bare_dot_forms() {
    assert_accepts(&[
        ("+5", NN, 500),
        ("+1234.05", NN, 123_405),
        (".5", NN, 50),
        ("5.", NN, 500),
        ("+.5", NN, 50),
    ]);
}

#[test]
fn accepts_exponent_spellings_that_are_whole_paise() {
    assert_accepts(&[
        ("1.2E7", NN, 1_200_000_000),
        ("1.2e7", NN, 1_200_000_000),
        ("1.23405E3", NN, 123_405),
        ("1E-2", NN, 1),
        ("100E-2", NN, 100),
        ("1e+2", NN, 10_000),
        ("1e0", NN, 100),
        ("0e0", NN, 0),
        ("5.E1", NN, 5_000),
    ]);
}

#[test]
fn accepts_quoted_string_form() {
    assert_accepts(&[
        ("\"1234.05\"", NN, 123_405),
        ("\"175614.64\"", NN, 17_561_464),
        ("\"1.2E7\"", NN, 1_200_000_000),
        ("\"+5\"", NN, 500),
        ("\".5\"", NN, 50),
        ("\"-12.05\"", ANY, -1_205),
    ]);
}

#[test]
fn trims_xml_whitespace_inside_quotes() {
    assert_accepts(&[
        ("\"  12.50 \"", NN, 1_250),
        ("\"\t12.50\"", NN, 1_250),
        ("\"12.50\r\n\"", NN, 1_250),
        ("\" \t\r\n5\n\r\t \"", NN, 500),
    ]);
}

#[test]
fn zero_and_negative_zero_are_zero_for_both_signs() {
    for raw in ["0", "-0", "0.00", "-0.00", "-0.0e5", "\"-0\"", "\"-0.00\""] {
        assert_eq!(paise(raw, NN), Ok(0), "input {raw:?} NonNegative");
        assert_eq!(paise(raw, ANY), Ok(0), "input {raw:?} Any");
    }
}

#[test]
fn negative_values_accepted_with_sign_any() {
    assert_accepts(&[
        ("-12.05", ANY, -1_205),
        ("-50", ANY, -5_000),
        ("-1.2E3", ANY, -120_000),
        ("\"-0.50\"", ANY, -50),
    ]);
}

#[test]
fn nonnegative_and_any_agree_on_positive_values() {
    for raw in ["1234.05", "0.01", "1e3", "\"99.99\""] {
        assert_eq!(paise(raw, NN), paise(raw, ANY), "input {raw:?}");
    }
}

// --- NotWholePaise ---

#[test]
fn rejects_sub_paise_precision_as_not_whole_paise() {
    let e = MoneyError::NotWholePaise;
    assert_rejects(&[
        ("1234.567", NN, e),
        ("1234.0499877", NN, e),
        ("0.001", NN, e),
        ("1E-3", NN, e),
        ("1e-30", NN, e),
        ("12.3456E1", NN, e),
        ("\"1234.567\"", NN, e),
        ("-1234.567", ANY, e),
    ]);
}

#[test]
fn does_not_round_sub_paise_values_either_way() {
    for raw in ["0.004", "0.005", "0.006", "0.0049999999"] {
        assert_eq!(
            paise(raw, NN),
            Err(MoneyError::NotWholePaise),
            "input {raw:?}"
        );
    }
}

// --- Overflow ---

#[test]
fn rejects_exponent_beyond_thirty_as_overflow() {
    let e = MoneyError::Overflow;
    assert_rejects(&[
        ("1e31", ANY, e),
        ("1E+31", ANY, e),
        ("1e-31", ANY, e),
        ("1e99999999999999999999", ANY, e),
    ]);
}

#[test]
fn rejects_values_beyond_i64_paise_as_overflow() {
    let e = MoneyError::Overflow;
    assert_rejects(&[
        ("92233720368547758.08", ANY, e),
        ("-92233720368547759.00", ANY, e),
        ("9.223372036854775808E16", ANY, e),
        ("12345678901234567890", ANY, e),
        ("123456789012345678901234567890.00", ANY, e),
        ("1e30", ANY, e),
        ("1e20", ANY, e),
        ("\"92233720368547758.08\"", ANY, e),
    ]);
}

#[test]
fn accepts_exact_i64_boundaries() {
    assert_accepts(&[
        ("92233720368547758.07", ANY, i64::MAX),
        ("92233720368547758.07", NN, i64::MAX),
        ("\"92233720368547758.07\"", NN, i64::MAX),
        ("9.223372036854775807E16", NN, i64::MAX),
        ("-92233720368547758.07", ANY, -i64::MAX),
    ]);
}

// --- Negative ---

#[test]
fn rejects_negative_values_under_nonnegative() {
    let e = MoneyError::Negative;
    assert_rejects(&[
        ("-50", NN, e),
        ("-0.01", NN, e),
        ("\"-0.50\"", NN, e),
        ("-1.2E3", NN, e),
        ("\" -5\"", NN, e),
    ]);
}

// --- BadFormat ---

#[test]
fn rejects_non_numeric_and_non_json_number_text() {
    let e = MoneyError::BadFormat;
    assert_rejects(&[
        ("NaN", ANY, e),
        ("nan", ANY, e),
        ("INF", ANY, e),
        ("-INF", ANY, e),
        ("Infinity", ANY, e),
        ("-Infinity", ANY, e),
        ("null", ANY, e),
        ("true", ANY, e),
        ("false", ANY, e),
        ("{}", ANY, e),
        ("[]", ANY, e),
        ("[1]", ANY, e),
        ("0x10", ANY, e),
        ("abc", ANY, e),
        ("", ANY, e),
        ("\"NaN\"", ANY, e),
        ("\"null\"", ANY, e),
    ]);
}

#[test]
fn rejects_malformed_numbers() {
    let e = MoneyError::BadFormat;
    assert_rejects(&[
        (".", ANY, e),
        ("+", ANY, e),
        ("-", ANY, e),
        ("-.", ANY, e),
        ("e5", ANY, e),
        (".e5", ANY, e),
        ("1e", ANY, e),
        ("1E", ANY, e),
        ("1e+", ANY, e),
        ("1e-", ANY, e),
        ("1e5.5", ANY, e),
        ("--5", ANY, e),
        ("+-5", ANY, e),
        ("-+5", ANY, e),
        ("++5", ANY, e),
        ("1.2.3", ANY, e),
        ("1 2", ANY, e),
        ("1_000", ANY, e),
        ("5-", ANY, e),
    ]);
}

#[test]
fn rejects_commas_and_suffixes_in_strings() {
    let e = MoneyError::BadFormat;
    assert_rejects(&[
        ("\"1,23,456.78\"", ANY, e),
        ("\"1,234.00\"", ANY, e),
        ("\"12.50 Dr\"", ANY, e),
        ("\"12.50Cr\"", ANY, e),
        ("\"INR 12.50\"", ANY, e),
        ("\"\u{20b9}12.50\"", ANY, e),
        ("\"1 2\"", ANY, e),
        ("\"12.50\"x", ANY, e),
        ("x\"12.50\"", ANY, e),
    ]);
}

#[test]
fn rejects_empty_and_whitespace_only_strings() {
    let e = MoneyError::BadFormat;
    assert_rejects(&[
        ("\"\"", ANY, e),
        ("\" \"", ANY, e),
        ("\" \t\r\n \"", ANY, e),
    ]);
}

#[test]
fn rejects_unterminated_or_lone_quote() {
    let e = MoneyError::BadFormat;
    assert_rejects(&[("\"", ANY, e), ("\"12.50", ANY, e), ("12.50\"", ANY, e)]);
}

#[test]
fn rejects_any_backslash_escape_in_strings() {
    let e = MoneyError::BadFormat;
    assert_rejects(&[
        (r#""12\u002e50""#, ANY, e),
        (r#""12\.50""#, ANY, e),
        (r#""\n12.50""#, ANY, e),
        (r#""12.50\""#, ANY, e),
        (r#""\"12.50\"""#, ANY, e),
        (r#""\\""#, ANY, e),
    ]);
}

#[test]
fn rejects_non_ascii_digits() {
    let e = MoneyError::BadFormat;
    assert_rejects(&[
        ("\u{0661}\u{0662}\u{0663}", ANY, e),
        ("\u{ff11}\u{ff12}", ANY, e),
        ("\"\u{0967}\u{0968}.50\"", ANY, e),
        ("1.\u{0665}0", ANY, e),
        ("1e\u{0662}", ANY, e),
    ]);
}

#[test]
fn rejects_non_ascii_whitespace_inside_quotes() {
    let e = MoneyError::BadFormat;
    assert_rejects(&[
        ("\"\u{a0}12.50\"", ANY, e),
        ("\"12.50\u{2003}\"", ANY, e),
        ("\"\u{b}12.50\"", ANY, e),
        ("\"\u{c}12.50\"", ANY, e),
    ]);
}

// --- Check order: BadFormat -> exponent Overflow -> NotWholePaise ->
// value Overflow -> Negative ---

#[test]
fn check_order_bad_format_beats_everything() {
    assert_rejects(&[
        ("-1,000", NN, MoneyError::BadFormat),
        ("-1,000.567", NN, MoneyError::BadFormat),
        ("\"-1e31,\"", NN, MoneyError::BadFormat),
        // Bad mantissa with an out-of-range exponent: grammar wins.
        ("1,0e99", ANY, MoneyError::BadFormat),
        ("x1e31", NN, MoneyError::BadFormat),
        ("\"12.5Dr e40\"", ANY, MoneyError::BadFormat),
    ]);
}

#[test]
fn check_order_exponent_overflow_beats_not_whole_paise() {
    assert_eq!(paise("1.234e-31", ANY), Err(MoneyError::Overflow));
}

#[test]
fn exponent_cap_applies_even_to_zero() {
    assert_rejects(&[
        ("0e31", ANY, MoneyError::Overflow),
        ("-0e99", NN, MoneyError::Overflow),
    ]);
}

#[test]
fn range_is_symmetric_so_i64_min_is_rejected_under_any() {
    assert_eq!(
        paise("-92233720368547758.08", ANY),
        Err(MoneyError::Overflow)
    );
}

#[test]
fn megabyte_inputs_are_decided_without_blowup() {
    let zeros = "0".repeat(1_000_000);
    assert_eq!(paise(&format!("1{zeros}"), ANY), Err(MoneyError::Overflow));
    assert_eq!(
        paise(&format!("0.{zeros}1"), ANY),
        Err(MoneyError::NotWholePaise)
    );
    assert_eq!(paise(&zeros, ANY), Ok(0));
}

#[test]
fn check_order_not_whole_paise_beats_negative() {
    assert_eq!(paise("-1234.567", NN), Err(MoneyError::NotWholePaise));
    assert_eq!(paise("\"-0.001\"", NN), Err(MoneyError::NotWholePaise));
}

#[test]
fn check_order_overflow_beats_negative() {
    assert_eq!(paise("-1e31", NN), Err(MoneyError::Overflow));
    assert_eq!(paise("-1e20", NN), Err(MoneyError::Overflow));
    assert_eq!(
        paise("-92233720368547758.08", NN),
        Err(MoneyError::Overflow)
    );
}

#[test]
fn check_order_not_whole_paise_beats_overflow_on_value_size() {
    // Huge and sub-paise, but the exponent is within +-30.
    assert_eq!(
        paise("12345678901234567890.123", ANY),
        Err(MoneyError::NotWholePaise)
    );
}

// --- Roundtrip with the TS generator's formatPaise ---

fn assert_roundtrip(p: i64) {
    let text = format_paise(p);
    let quoted = format!("\"{text}\"");
    assert_eq!(paise(&text, ANY), Ok(p), "number form {text:?}");
    assert_eq!(paise(&quoted, ANY), Ok(p), "string form {quoted}");
    if p >= 0 {
        assert_eq!(paise(&text, NN), Ok(p), "number form {text:?} NN");
    } else {
        assert_eq!(paise(&text, NN), Err(MoneyError::Negative), "{text:?} NN");
    }
}

#[test]
fn format_paise_helper_matches_ts_generator() {
    assert_eq!(format_paise(123_405), "1234.05");
    assert_eq!(format_paise(-1_205), "-12.05");
    assert_eq!(format_paise(0), "0.00");
    assert_eq!(format_paise(7), "0.07");
    assert_eq!(format_paise(i64::MAX), "92233720368547758.07");
}

#[test]
fn roundtrips_format_paise_over_dense_sweep() {
    for p in -100_000..=100_000 {
        assert_roundtrip(p);
    }
}

#[test]
fn roundtrips_format_paise_at_edges_and_powers_of_ten() {
    let mut values = vec![i64::MAX, i64::MAX - 1, -i64::MAX, -(i64::MAX - 1)];
    let mut pow: i64 = 1;
    loop {
        for delta in [-1, 0, 1] {
            if let Some(v) = pow.checked_add(delta) {
                values.push(v);
                values.push(-v);
            }
        }
        match pow.checked_mul(10) {
            Some(next) => pow = next,
            None => break,
        }
    }
    for p in values {
        assert_roundtrip(p);
    }
}
