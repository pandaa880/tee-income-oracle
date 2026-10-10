import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { buildIntent, checkIntent } from './intent.ts';

// The enclave's own golden (enclave/tests/intent.rs, `intent_is_the_exact_section_9_text`): the
// browser must produce these exact bytes, not whatever its own builder happens to produce.
const SESSION_ID = '232c88fe-595d-4809-b82f-bedf270b4887';
const WALLET = address('3bq9cT2LQ1SKiSS31rEsmdYrUjw6A8qY8CDJmMbSuHWS');
const POLICY = '81112a23f4ee2835f6459b1f25d9159566204bc2e3e4d318b3ac73d526932e1c';
const EXPIRES = 1_790_417_400n;
const ENCLAVE_LITERAL =
  'tee-income-oracle: bind session\n' +
  'session: 232c88fe-595d-4809-b82f-bedf270b4887\n' +
  'wallet: 3bq9cT2LQ1SKiSS31rEsmdYrUjw6A8qY8CDJmMbSuHWS\n' +
  'policy: 81112a23f4ee2835f6459b1f25d9159566204bc2e3e4d318b3ac73d526932e1c\n' +
  'expires: 1790417400';

const session = (intent = ENCLAVE_LITERAL, intentExpires = EXPIRES) => ({
  sessionId: SESSION_ID,
  intent,
  intentExpires,
});

describe('buildIntent', () => {
  it('produces the enclave golden byte for byte', () => {
    expect(
      buildIntent({
        sessionId: SESSION_ID,
        wallet: WALLET,
        policyHashHex: POLICY,
        expires: EXPIRES,
      }),
    ).toBe(ENCLAVE_LITERAL);
  });
});

describe('checkIntent', () => {
  it('accepts the enclave golden and returns its UTF-8 bytes', () => {
    const result = checkIntent(session(), WALLET, [POLICY], EXPIRES - 600n);
    expect(result).toEqual({ ok: true, value: new TextEncoder().encode(ENCLAVE_LITERAL) });
  });

  it.each([
    ['expires exactly now', EXPIRES, false],
    ['now + 600 s (the enclave lifetime)', EXPIRES - 600n, true],
    ['now + 660 s (lifetime plus skew)', EXPIRES - 660n, true],
    ['now + 661 s', EXPIRES - 661n, false],
    ['already past', EXPIRES + 1n, false],
  ])('expiry %s → accepted: %s', (_, now, accepted) => {
    expect(checkIntent(session(), WALLET, [POLICY], now).ok).toBe(accepted);
  });

  it('rejects an uppercase policy hex (the enclave writes lowercase)', () => {
    const upper = ENCLAVE_LITERAL.replace(POLICY, POLICY.toUpperCase());
    expect(
      checkIntent(session(upper), WALLET, [POLICY, POLICY.toUpperCase()], EXPIRES - 600n),
    ).toEqual({
      ok: false,
      error: { code: 'protocol_error' },
    });
  });

  it('rejects CRLF line endings', () => {
    const crlf = ENCLAVE_LITERAL.replaceAll('\n', '\r\n');
    expect(checkIntent(session(crlf), WALLET, [POLICY], EXPIRES - 600n).ok).toBe(false);
  });
});
