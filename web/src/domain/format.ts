// Display formatting. Amounts stay bigint until the last step (CODING-GUIDELINES §3).
import { getBase16Codec } from '@solana/kit';
import { formatAmount } from './amount.ts';

const HEX = getBase16Codec();

/** Lower-case hex of a hash or id. */
export function hexOf(bytes: Uint8Array): string {
  return HEX.decode(bytes);
}

/** "7xKp…3fQa" */
export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** "81112a23…932e1c" */
export function shortHex(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}

/** `formatAmount` with thousands separators: "5,000", "2,500.5". */
export function formatTokens(value: bigint, decimals = 6): string {
  const [whole = '', fraction] = formatAmount(value, decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** "9:41"; never negative. */
export function formatCountdown(seconds: number): string {
  const left = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(left / 60);
  const rest = left % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

/** "<1 min", "3 min", "2 h", "30 days". */
export function formatAge(seconds: bigint | number): string {
  const s = Number(seconds);
  if (s < 60) return '<1 min';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} days`;
}

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

/** "27 Sep 2026" (UTC, so the same on every machine). */
export function formatUnixDate(seconds: bigint): string {
  return DATE.format(new Date(Number(seconds) * 1000));
}

/** "27 Sep 2026, 14:02 UTC" */
export function formatUnixDateTime(seconds: bigint): string {
  return `${DATE_TIME.format(new Date(Number(seconds) * 1000))} UTC`;
}
