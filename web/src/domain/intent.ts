// The §9 intent the borrower signs. The text comes from the untrusted gateway, so the browser
// rebuilds it and signs only an exact match: a gateway can't get a signature over anything else.
import type { Address } from '@solana/kit';
import type { Result, Session } from './types.ts';

/** FORMATS §9: five `\n`-separated lines, no trailing newline. */
export function buildIntent(f: {
  sessionId: string;
  wallet: Address;
  policyHashHex: string;
  expires: bigint;
}): string {
  return [
    'tee-income-oracle: bind session',
    `session: ${f.sessionId}`,
    `wallet: ${f.wallet}`,
    `policy: ${f.policyHashHex}`,
    `expires: ${f.expires}`,
  ].join('\n');
}

const POLICY_LINE = /^policy: ([0-9a-f]{64})$/m;

/** The enclave sets `expires` to now + 600 s (FORMATS §10); allow a little clock skew. */
const MAX_LIFETIME_SECS = 600n;
const SKEW_SECS = 60n;

/**
 * The exact bytes to sign, or `protocol_error` when the gateway's intent isn't the §9 text for
 * this session, this wallet and this expiry, or names a policy no listed pool lends under (an
 * attestation under it would only ever get `PolicyMismatch`), or expires outside now..now+600 s.
 */
export function checkIntent(
  session: Session,
  wallet: Address,
  poolPolicies: readonly string[],
  now: bigint,
): Result<Uint8Array> {
  const policy = POLICY_LINE.exec(session.intent)?.[1];
  const expected =
    policy === undefined
      ? undefined
      : buildIntent({
          sessionId: session.sessionId,
          wallet,
          policyHashHex: policy,
          expires: session.intentExpires,
        });
  const expires = session.intentExpires;
  const fresh = expires > now && expires <= now + MAX_LIFETIME_SECS + SKEW_SECS;
  if (
    !fresh ||
    expected !== session.intent ||
    policy === undefined ||
    !poolPolicies.includes(policy)
  ) {
    return { ok: false, error: { code: 'protocol_error' } };
  }
  return { ok: true, value: new TextEncoder().encode(expected) };
}
