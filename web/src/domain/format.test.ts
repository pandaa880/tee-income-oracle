import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatCountdown,
  formatPercent,
  formatTokens,
  formatUnixDate,
  shortAddress,
  shortEthAddress,
  shortHex,
} from './format.ts';

describe('shortAddress', () => {
  it('keeps the first and last four characters', () => {
    expect(shortAddress('7xKpAbCdEfGhIjKlMnOpQrStUvWxYz123fQa')).toBe('7xKp…3fQa');
  });
});

describe('shortHex', () => {
  it('keeps the first eight and last six characters', () => {
    expect(shortHex('81112a23aabbccddeeff00112233445566778899932e1c')).toBe('81112a23…932e1c');
  });
});

describe('shortEthAddress', () => {
  it('keeps the 0x and first four hex, then the last four', () => {
    expect(shortEthAddress('0xb6dda6eed87322334ba37809bd451a852ae6574c')).toBe('0xb6dd…574c');
  });
});

describe('formatTokens', () => {
  it.each([
    [5_000_000_000n, '5,000'],
    [2_500_500_000n, '2,500.5'],
    [1_234_567_890_000n, '1,234,567.89'],
    [0n, '0'],
    [1n, '0.000001'],
    [999_000_000n, '999'],
  ])('%s -> %s', (value, text) => {
    expect(formatTokens(value)).toBe(text);
  });

  it('honours the decimals argument', () => {
    expect(formatTokens(1_500n, 2)).toBe('15');
  });
});

describe('formatCountdown', () => {
  it.each([
    [581, '9:41'],
    [5, '0:05'],
    [0, '0:00'],
    [-3, '0:00'],
    [600, '10:00'],
  ])('%i s -> %s', (secs, text) => {
    expect(formatCountdown(secs)).toBe(text);
  });
});

describe('formatAge', () => {
  it.each([
    [0, '<1 min'],
    [59, '<1 min'],
    [180, '3 min'],
    [7_200, '2 h'],
    [2_592_000, '30 days'],
    [180n, '3 min'],
  ])('%s -> %s', (secs, text) => {
    expect(formatAge(secs)).toBe(text);
  });
});

describe('formatUnixDate', () => {
  it('is a readable date that includes the year', () => {
    expect(formatUnixDate(1_790_500_000n)).toContain('2026');
  });

  it('is deterministic', () => {
    expect(formatUnixDate(1_790_500_000n)).toBe(formatUnixDate(1_790_500_000n));
  });
});

describe('formatPercent', () => {
  it.each([
    [0, '0.0%'],
    [2500, '25.0%'],
    [1234, '12.3%'],
    [3875, '38.7%'],
    [5, '0.0%'],
    [10, '0.1%'],
    [10_000, '100.0%'],
  ])('%i bps -> %s (floored to one decimal)', (bps, text) => {
    expect(formatPercent(bps)).toBe(text);
  });
});
