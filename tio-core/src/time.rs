//! Integer-only UTC date formatting. tio-core has no clock: callers pass
//! unix seconds in.

const SECS_PER_DAY: i64 = 86_400;

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
