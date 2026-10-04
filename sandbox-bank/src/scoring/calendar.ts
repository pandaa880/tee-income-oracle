/**
 * Proleptic Gregorian date → days since 1970-01-01, integers only (Howard
 * Hinnant's `days_from_civil`, as in tio-core `time.rs`). Used instead of
 * `Date.UTC`, which maps years 0–99 to 1900–1999.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const monthIndex = (month + 9) % 12; // 0 = March
  const dayOfYear = Math.floor((153 * monthIndex + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}
