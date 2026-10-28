// formatReport: the text the CLI prints, one PASS/FAIL line per check, then the verdict.
import { describe, expect, it } from 'vitest';
import { CHECKS, type Check, type VerificationReport, formatReport, isExpired } from './report.ts';
import { WALLET, testDeployment, walletChain } from './test-fixtures.ts';
import { readAttestation } from './chain/attestation.ts';

async function reportWith(statuses: Check['status'][]): Promise<VerificationReport> {
  const { chain } = await walletChain(1);
  const attestation = await readAttestation(chain, await testDeployment(), WALLET);
  const checks = CHECKS.map((c, i): Check => ({
    ...c,
    status: statuses[i] ?? 'pass',
    detail: `detail-${c.id}`,
  }));
  return {
    wallet: WALLET,
    attestation,
    entry: {
      measurementId: 1,
      measurementKind: 1,
      imageId: '7d'.repeat(32),
      attester: `0x${'b6'.repeat(20)}`,
      attestationDocHash: 'ab'.repeat(32),
      registeredAt: 1_790_000_000n,
      revokedAt: 0n,
    },
    checks,
    verdict: statuses.includes('fail') ? 'FAIL' : 'PASS',
  };
}

const linesStartingWith = (text: string, prefix: string): string[] =>
  text.split('\n').filter((line) => line.startsWith(prefix));

describe('formatReport', () => {
  it('prints_seven_pass_lines_and_a_pass_verdict_when_everything_passes', async () => {
    const text = formatReport(await reportWith([]));
    expect(linesStartingWith(text, 'PASS')).toHaveLength(7);
    expect(linesStartingWith(text, 'FAIL')).toHaveLength(0);
    expect(linesStartingWith(text, 'VERDICT')).toEqual(['VERDICT PASS']);
  });

  it('prints_the_title_and_detail_of_every_check_in_board_order', async () => {
    const text = formatReport(await reportWith([]));
    const lines = linesStartingWith(text, 'PASS');
    CHECKS.forEach((check, i) => {
      expect(lines[i]).toContain(check.title);
      expect(lines[i]).toContain(`detail-${check.id}`);
    });
  });

  it('marks_exactly_the_failed_check_as_fail_and_the_verdict_as_fail', async () => {
    const text = formatReport(await reportWith(['pass', 'pass', 'pass', 'fail']));
    expect(linesStartingWith(text, 'PASS')).toHaveLength(6);
    const failed = linesStartingWith(text, 'FAIL');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('Image id matches the registry');
    expect(linesStartingWith(text, 'VERDICT')).toEqual(['VERDICT FAIL']);
  });

  it('prints_the_verdict_after_the_check_lines', async () => {
    const lines = formatReport(await reportWith([]))
      .trimEnd()
      .split('\n');
    expect(lines.at(-1)).toBe('VERDICT PASS');
  });

  it('shows_the_wallet_and_the_attestation_address', async () => {
    const report = await reportWith([]);
    const text = formatReport(report);
    expect(text).toContain(WALLET);
    expect(text).toContain(report.attestation.address);
  });

  it('marks_the_tier_expired_from_the_expiry_second_on', async () => {
    const report = await reportWith([]);
    const expiryMs = Number(report.attestation.expiry) * 1000;
    expect(formatReport(report, expiryMs - 1000)).not.toContain('(EXPIRED)');
    expect(formatReport(report, expiryMs)).toContain('(EXPIRED)');
  });

  it('keeps_the_verdict_when_the_tier_has_expired', async () => {
    const report = await reportWith([]);
    const afterExpiryMs = Number(report.attestation.expiry + 1n) * 1000;
    expect(linesStartingWith(formatReport(report, afterExpiryMs), 'VERDICT')).toEqual([
      'VERDICT PASS',
    ]);
  });
});

// The demo pool lends strictly before `expiry` (FORMATS §14, `check_expiry`).
describe('isExpired', () => {
  it.each([
    ['one_second_before', false, 999n],
    ['at', true, 1_000n],
    ['one_second_after', true, 1_001n],
  ])('%s_expiry_gives_%s', (_name, expired, now) => {
    expect(isExpired(1_000n, now)).toBe(expired);
  });
});
