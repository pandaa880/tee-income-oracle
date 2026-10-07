/**
 * ReBIT date-time values (FORMATS §12): `YYYY-MM-DDTHH:MM:SS[.1–9 digits]`
 * with `Z`, `±HH:MM` or `±HHMM`, or no zone (read as UTC). The fraction is
 * truncated. A date alone is not a date-time, and the calendar date and the
 * time of day must exist whatever the zone (no 30 February, no hour 24).
 */

const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/;

const MINUTE = 60;
const HOUR = 3600;

/** Unix seconds, or `undefined` if `value` isn't a valid ReBIT date-time. */
export function parseRebitTimestamp(value: string): number | undefined {
  const m = DATE_TIME_RE.exec(value);
  if (m === null) {
    return undefined;
  }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const [, , , , , , , , sign, oh, om] = m;
  if (y === undefined || mo === undefined || d === undefined) {
    return undefined;
  }
  const local = Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
  if (!isRealDate(local, y, mo, d) || !inRange(h, 23) || !inRange(mi, 59) || !inRange(s, 59)) {
    return undefined;
  }
  if (sign === undefined) {
    return local;
  }
  const offH = Number(oh);
  const offM = Number(om);
  if (!inRange(offH, 23) || !inRange(offM, 59)) {
    return undefined;
  }
  const offset = offH * HOUR + offM * MINUTE;
  return sign === '+' ? local - offset : local + offset;
}

/** Date.UTC rolls 30 February over to March: the parts must survive the round trip. */
function isRealDate(unix: number, y: number, mo: number, d: number): boolean {
  const back = new Date(unix * 1000);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
}

function inRange(n: number | undefined, max: number): boolean {
  return n !== undefined && n >= 0 && n <= max;
}
