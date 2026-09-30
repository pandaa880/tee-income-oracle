//! Money as integer paise, parsed from raw JSON text (`docs/FORMATS.md` §1).
//!
//! ReBIT declares `Transaction.amount` as `xs:float` and balances as
//! `xs:string` with no pattern, so real banks may spell the same value many
//! ways (`1.2E7`, `85000.0`, `1234.050`). Any spelling that denotes an exact
//! whole number of paise is accepted. Nothing is ever rounded and nothing
//! goes through `f64`: a float can't hold most rupee values exactly, and two
//! scorers summing floats in a different order can disagree on a tier.

use zeroize::Zeroize;

use crate::ErrorCode;

/// Money in integer paise (₹1 = 100 paise). The only money type in
/// `tio-core`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Zeroize)]
pub struct Paise(i64);

impl Paise {
    /// Zero paise.
    pub const ZERO: Paise = Paise(0);

    /// Wraps a paise count.
    pub const fn new(paise: i64) -> Self {
        Paise(paise)
    }

    /// The paise count.
    pub const fn into_inner(self) -> i64 {
        self.0
    }
}

/// Which signs a money field may carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sign {
    /// Transaction `amount`: the direction comes from `CREDIT`/`DEBIT`, so a
    /// negative amount is a data error.
    NonNegative,
    /// Balances: negative means overdrawn.
    Any,
}

/// Why a money value was rejected. Every variant maps to the one external
/// code `bad_fi_data`; the variants exist so tests can tell the checks apart.
/// Messages never contain the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum MoneyError {
    /// Not a JSON number or a numeric JSON string (e.g. `NaN`, `1,234.00`,
    /// an escape, an empty string).
    #[error("money value is not a decimal number")]
    BadFormat,
    /// A valid number that is not a whole number of paise (e.g. `1234.567`).
    #[error("money value is not a whole number of paise")]
    NotWholePaise,
    /// A negative value where only non-negative values are allowed.
    #[error("negative money value where not allowed")]
    Negative,
    /// Magnitude above `i64::MAX` paise, or an exponent beyond ±30. The range
    /// is symmetric (`i64::MIN` is rejected), so every `Paise` returned by
    /// [`parse_paise`] can be negated safely.
    #[error("money value out of range")]
    Overflow,
}

/// Largest accepted exponent magnitude. Real amounts need about 10; the cap
/// keeps a hostile `1e999999999` from costing work.
const MAX_EXPONENT: i64 = 30;

/// Whitespace trimmed inside a string value. Defensive: valid JSON can only
/// carry a raw space here (raw control characters are invalid JSON and their
/// escapes are refused), but a bank that pads with any of these still means
/// the same number.
const XML_WHITESPACE: [char; 4] = [' ', '\t', '\r', '\n'];

/// One syntactically valid decimal, still as text: `-12.5E3` is
/// `negative, int "12", frac "5", exponent 3`.
struct Decimal<'a> {
    negative: bool,
    int: &'a str,
    frac: &'a str,
    exponent: i64,
}

impl ErrorCode for MoneyError {
    fn code(&self) -> &'static str {
        "bad_fi_data"
    }
}

/// Parses the raw JSON text of one money value (a JSON number such as
/// `1234.05`, or a JSON string such as `"1234.05"`) into exact paise.
///
/// # Errors
/// [`MoneyError`], checked in this order: `BadFormat`, then `Overflow` for an
/// exponent beyond ±30, `NotWholePaise`, `Overflow` for the value's size, and
/// `Negative` last.
pub fn parse_paise(raw_json: &str, sign: Sign) -> Result<Paise, MoneyError> {
    let decimal = split_decimal(unquote(raw_json)?)?;
    let magnitude = magnitude_paise(&decimal)?;
    if decimal.negative && magnitude > 0 && sign == Sign::NonNegative {
        return Err(MoneyError::Negative);
    }
    // `magnitude ≤ i64::MAX`, so the negation can't overflow.
    Ok(Paise(if decimal.negative {
        -magnitude
    } else {
        magnitude
    }))
}

/// A JSON string loses its quotes and surrounding whitespace; a JSON number
/// is returned as is. Escapes are never decoded (decoding would let `1`
/// pose as `1`): the `\` is left in place, and the grammar check rejects it.
fn unquote(raw_json: &str) -> Result<&str, MoneyError> {
    let Some(rest) = raw_json.strip_prefix('"') else {
        return Ok(raw_json);
    };
    let inner = rest.strip_suffix('"').ok_or(MoneyError::BadFormat)?;
    Ok(inner.trim_matches(XML_WHITESPACE))
}

/// Checks the grammar `[+|-] (digits ['.' [digits]] | '.' digits)
/// [(e|E) [+|-] digits]` and splits the text into its parts.
///
/// The mantissa is validated before the exponent is parsed, so a malformed
/// value is always `BadFormat`, even when its exponent is also out of range.
fn split_decimal(text: &str) -> Result<Decimal<'_>, MoneyError> {
    let (negative, unsigned) = split_sign(text);
    let (mantissa, exponent_text) = match unsigned.split_once(['e', 'E']) {
        Some((mantissa, exponent_text)) => (mantissa, Some(exponent_text)),
        None => (unsigned, None),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if !is_digits(int) || !is_digits(frac) || (int.is_empty() && frac.is_empty()) {
        return Err(MoneyError::BadFormat);
    }
    let exponent = exponent_text.map_or(Ok(0), parse_exponent)?;
    Ok(Decimal {
        negative,
        int,
        frac,
        exponent,
    })
}

/// Splits off one optional leading `+` or `-`.
fn split_sign(text: &str) -> (bool, &str) {
    match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    }
}

/// Parses the exponent after `e`/`E`. Its digits are validated before its
/// size, so `1e5x` is `BadFormat` and `1e99` is `Overflow`.
fn parse_exponent(text: &str) -> Result<i64, MoneyError> {
    let (negative, digits) = split_sign(text);
    if digits.is_empty() || !is_digits(digits) {
        return Err(MoneyError::BadFormat);
    }
    let significant = digits.trim_start_matches('0');
    // More than two significant digits is ≥ 100, far past the cap; checking
    // the length first means a 1,000-digit exponent never gets parsed.
    if significant.len() > 2 {
        return Err(MoneyError::Overflow);
    }
    // Only "" (all zeros) fails to parse here, and it means 0.
    let value: i64 = significant.parse().unwrap_or(0);
    if value > MAX_EXPONENT {
        return Err(MoneyError::Overflow);
    }
    Ok(if negative { -value } else { value })
}

/// True if every byte is an ASCII digit (vacuously true for "").
fn is_digits(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_digit())
}

/// The value's size in paise, exactly, from its digits: `12.5E3` is digits
/// `125` × 10^(3 − 1 + 2). Trailing zeros are folded into the power of ten,
/// so `1234.050` and `1234.05` are the same value; only a power that is
/// still negative after that means a fraction of a paisa.
fn magnitude_paise(decimal: &Decimal<'_>) -> Result<i64, MoneyError> {
    let digits = format!("{}{}", decimal.int, decimal.frac);
    let digits = digits.trim_start_matches('0');
    let significant = digits.trim_end_matches('0');
    if significant.is_empty() {
        return Ok(0);
    }
    let trailing_zeros = to_i64(digits.len() - significant.len())?;
    let power = decimal.exponent + 2 - to_i64(decimal.frac.len())? + trailing_zeros;
    if power < 0 {
        return Err(MoneyError::NotWholePaise);
    }
    // The digit loops are bounded: `significant` starts with a nonzero digit,
    // so checked math fails by the 20th step (i64::MAX has 19 digits). The
    // rest is one linear pass over input that is already in memory.
    let mut value: i64 = 0;
    for byte in significant.bytes() {
        let digit = char::from(byte).to_digit(10).ok_or(MoneyError::BadFormat)?;
        value = value
            .checked_mul(10)
            .and_then(|v| v.checked_add(i64::from(digit)))
            .ok_or(MoneyError::Overflow)?;
    }
    for _ in 0..power {
        value = value.checked_mul(10).ok_or(MoneyError::Overflow)?;
    }
    Ok(value)
}

/// A string length as `i64`, for power arithmetic.
fn to_i64(len: usize) -> Result<i64, MoneyError> {
    i64::try_from(len).map_err(|_| MoneyError::Overflow)
}

#[cfg(test)]
mod tests;
