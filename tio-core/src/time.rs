//! Integer-only UTC dates: formatting, and parsing ReBIT timestamps and dates
//! (`docs/FORMATS.md` §0, §12). tio-core has no clock: callers pass unix
//! seconds in.

const SECS_PER_DAY: i64 = 86_400;

/// A timestamp or date that doesn't match the accepted grammar or names a
/// day or time that doesn't exist. Carries no data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("invalid date or time")]
pub struct TimeError;

/// Parses a ReBIT timestamp, `YYYY-MM-DD'T'HH:MM:SS[.fraction][Z|±HH:MM|±HHMM]`,
/// into unix seconds (UTC). No zone means UTC (FORMATS §12); an offset is
/// converted; the fraction (1–9 digits) is truncated.
///
/// # Errors
/// [`TimeError`] for any other text or a day/time that doesn't exist.
pub fn parse_rebit_timestamp(s: &str) -> Result<i64, TimeError> {
    let (date, rest) = s.split_once('T').ok_or(TimeError)?;
    let days = parse_ymd(date)?;
    let (clock, offset_secs) = split_zone(rest)?;
    let secs_of_day = parse_clock(clock)?;
    Ok(days * SECS_PER_DAY + secs_of_day - offset_secs)
}

/// Parses a date into days since 1970-01-01: an `xs:date`, `YYYY-MM-DD` with
/// an optional zone (`Z`, `±HH:MM`, `±HHMM`), or a full timestamp (Finvu sends
/// datetimes where the XSD says `xs:date`). The **written** date is used; a
/// zone is validated but never shifts the day.
///
/// # Errors
/// [`TimeError`] for any other text or a day that doesn't exist.
pub fn parse_date(s: &str) -> Result<i64, TimeError> {
    match s.split_once('T') {
        None => {
            let (date, zone) = s.split_at_checked(10).ok_or(TimeError)?;
            check_date_zone(zone)?;
            parse_ymd(date)
        }
        Some((date, _)) => {
            parse_rebit_timestamp(s)?;
            parse_ymd(date)
        }
    }
}

/// The optional zone after an `xs:date`: nothing, `Z`, or a valid offset.
fn check_date_zone(zone: &str) -> Result<(), TimeError> {
    if zone.is_empty() || zone == "Z" {
        return Ok(());
    }
    let digits = zone
        .strip_prefix('+')
        .or_else(|| zone.strip_prefix('-'))
        .ok_or(TimeError)?;
    parse_offset(digits).map(|_| ())
}

/// `YYYY-MM-DD` with a day that exists → days since 1970-01-01.
fn parse_ymd(s: &str) -> Result<i64, TimeError> {
    let mut parts = s.split('-');
    let (Some(y), Some(m), Some(d), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TimeError);
    };
    let (year, month, day) = (
        fixed_digits(y, 4)?,
        fixed_digits(m, 2)?,
        fixed_digits(d, 2)?,
    );
    if !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) {
        return Err(TimeError);
    }
    Ok(days_from_civil(year, month, day))
}

/// `HH:MM:SS[.fraction]` → seconds since midnight. No leap second.
fn parse_clock(s: &str) -> Result<i64, TimeError> {
    let (hms, fraction) = match s.split_once('.') {
        Some((hms, fraction)) => (hms, Some(fraction)),
        None => (s, None),
    };
    if let Some(fraction) = fraction {
        if !(1..=9).contains(&fraction.len()) || !is_ascii_digits(fraction) {
            return Err(TimeError);
        }
    }
    let mut parts = hms.split(':');
    let (Some(h), Some(m), Some(sec), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TimeError);
    };
    let (hour, minute, second) = (
        fixed_digits(h, 2)?,
        fixed_digits(m, 2)?,
        fixed_digits(sec, 2)?,
    );
    if hour > 23 || minute > 59 || second > 59 {
        return Err(TimeError);
    }
    Ok(hour * 3600 + minute * 60 + second)
}

/// Splits the zone off the clock: `Z`, `±HH:MM`, `±HHMM` or nothing (UTC).
/// Returns the clock text and the offset east of UTC in seconds.
fn split_zone(rest: &str) -> Result<(&str, i64), TimeError> {
    if let Some(clock) = rest.strip_suffix('Z') {
        return Ok((clock, 0));
    }
    let Some(at) = rest.find(['+', '-']) else {
        return Ok((rest, 0));
    };
    let (clock, zone) = rest.split_at_checked(at).ok_or(TimeError)?;
    let (sign, digits) = match zone.strip_prefix('+') {
        Some(digits) => (1, digits),
        None => (-1, zone.strip_prefix('-').ok_or(TimeError)?),
    };
    Ok((clock, sign * parse_offset(digits)?))
}

/// `HH:MM` or `HHMM` → seconds.
fn parse_offset(s: &str) -> Result<i64, TimeError> {
    let (h, m) = match s.split_once(':') {
        Some(parts) => parts,
        None if s.len() == 4 => s.split_at_checked(2).ok_or(TimeError)?,
        None => return Err(TimeError),
    };
    let (hour, minute) = (fixed_digits(h, 2)?, fixed_digits(m, 2)?);
    if hour > 23 || minute > 59 {
        return Err(TimeError);
    }
    Ok((hour * 60 + minute) * 60)
}

/// Exactly `len` ASCII digits → their value.
fn fixed_digits(s: &str, len: usize) -> Result<i64, TimeError> {
    if s.len() != len || !is_ascii_digits(s) {
        return Err(TimeError);
    }
    s.parse().map_err(|_| TimeError)
}

fn is_ascii_digits(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_digit())
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Proleptic Gregorian (year, month, day) to days since 1970-01-01. Howard
/// Hinnant's `days_from_civil`, the inverse of [`civil_from_days`].
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12; // 0 = March
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Formats unix seconds as ReBIT's `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` (UTC).
pub fn format_iso_utc(unix_secs: i64) -> String {
    let (year, month, day) = civil_from_days(unix_secs.div_euclid(SECS_PER_DAY));
    let secs_of_day = unix_secs.rem_euclid(SECS_PER_DAY);
    let (hour, minute, second) = (secs_of_day / 3600, secs_of_day / 60 % 60, secs_of_day % 60);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

/// Days since 1970-01-01 to a proleptic Gregorian (year, month, day).
/// Howard Hinnant's `civil_from_days`, integers only.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153; // 0 = March
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests;
