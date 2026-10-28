import { type Address, address } from '@solana/kit';
import type { AttestationFacts } from '@tio/verifier/chain';
import { type Deployment, parseDeployment } from '@tio/verifier/deployment';
import {
  CHECKS,
  type Check,
  type CheckId,
  type EntryFacts,
  type VerificationReport,
} from '@tio/verifier/report';
import { describe, expect, it } from 'vitest';
import devnet from '../../../deployments/devnet.json';
import { explorerAddressUrl } from './explorer.ts';
import { formatUnixDate, shortAddress, shortHex } from './format.ts';
import { tierTone } from './tier-tone.ts';
import {
  CHECK_EXPLANATIONS,
  parseWalletInput,
  type ViewContext,
  verifyView,
} from './verify-view.ts';

const WALLET: Address = address('3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND');
const ATTESTATION: Address = address('DvDkXcQFJAvCvrMfoujKu2BWfWqVYRmL8WW9hpMgW8KC');
const ENTRY: Address = address('C4MwVjB3hDiCaAWXQsCAViM3AHHyirDkyjpRw7EzBgNn');
const OTHER_SIGNER: Address = address('9jR2xmkX4ccCPkrH58NZPpLtSA29dQggXosyxhLFusDq');
const SAS_SIGNER: Address = address('HznYLdoTuhm53WjdvNcQBbGT71n9msXgpJcKiya2Moti');
const POLICY_HEX = '81112a23'.padEnd(58, '0') + '932e1c';

const ISSUED_AT = 1_790_000_000n;
const EXPIRY = 1_790_600_000n;
const REPO_URL = 'https://github.com/pandaa880/tee-income-oracle';

const deployment: Deployment = parseDeployment(devnet);

const attestation = (overrides: Partial<AttestationFacts> = {}): AttestationFacts => ({
  tier: 1,
  proofType: 1,
  measurementId: 1,
  policyHash: Uint8Array.from(POLICY_HEX.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16)),
  consentHash: new Uint8Array(32).fill(0x22),
  issuedAt: ISSUED_AT,
  windowFrom: 1_758_844_800,
  windowTo: 1_790_380_800,
  address: ATTESTATION,
  signer: SAS_SIGNER,
  signerOk: true,
  expiry: EXPIRY,
  ...overrides,
});

const entry: EntryFacts = {
  measurementId: 1,
  measurementKind: 1,
  imageId: '7dd33d974511a825c871f267ebdc6b34fb9cdc2c63210e27a31a8c7cfb96daff',
  attester: '0xb6dda6eed87322334ba37809bd451a852ae6574c',
  attestationDocHash: '9f'.repeat(32),
  registeredAt: 1_790_000_000n,
  revokedAt: 0n,
};

const passing: Check[] = CHECKS.map((c) => ({
  id: c.id,
  title: c.title,
  status: 'pass',
  detail: `detail of ${c.id}`,
}));

const failing = (...ids: CheckId[]): Check[] =>
  passing.map((c) => (ids.includes(c.id) ? { ...c, status: 'fail', detail: `broken ${c.id}` } : c));

const report = (overrides: Partial<VerificationReport> = {}): VerificationReport => {
  const checks = overrides.checks ?? passing;
  const att = overrides.attestation ?? attestation();
  return {
    wallet: WALLET,
    attestation: att,
    entry,
    checks,
    verdict: att.signerOk && checks.every((c) => c.status === 'pass') ? 'PASS' : 'FAIL',
    ...overrides,
  };
};

const context = (overrides: Partial<ViewContext> = {}): ViewContext => ({
  deployment,
  cluster: 'devnet',
  release: 'v0.5.0',
  entryAddress: ENTRY,
  repoUrl: REPO_URL,
  nowSeconds: ISSUED_AT + 1000n,
  ...overrides,
});

describe('verifyView headline and verdict', () => {
  it('counts a fully passing report as "Build #1 · 7 of 7 checks pass" with a positive PASS', () => {
    const view = verifyView(report(), context());
    expect(view.headline).toBe('Build #1 · 7 of 7 checks pass');
    expect(view.verdict).toBe('PASS');
    expect(view.verdictTone).toBe('positive');
    expect(view.verdictNote).toBeNull();
  });

  it('names the build the attestation points at, not a fixed one', () => {
    const view = verifyView(
      report({ attestation: attestation({ measurementId: 0 }) }),
      context({ entryAddress: ENTRY }),
    );
    expect(view.headline).toBe('Build #0 · 7 of 7 checks pass');
  });

  it('counts one failing check as 6 of 7 and a negative FAIL, without a signer note', () => {
    const view = verifyView(report({ checks: failing('entry_active') }), context());
    expect(view.headline).toBe('Build #1 · 6 of 7 checks pass');
    expect(view.verdict).toBe('FAIL');
    expect(view.verdictTone).toBe('negative');
    expect(view.verdictNote).toBeNull();
  });

  it('counts every failing check (all seven failing is 0 of 7)', () => {
    const all = passing.map((c) => ({ ...c, status: 'fail' as const }));
    expect(verifyView(report({ checks: all }), context()).headline).toBe(
      'Build #1 · 0 of 7 checks pass',
    );
  });

  it('fails a report whose checks all pass when the signer is not the oracle, and says why', () => {
    const view = verifyView(
      report({ attestation: attestation({ signerOk: false, signer: OTHER_SIGNER }) }),
      context(),
    );
    expect(view.headline).toBe('Build #1 · 7 of 7 checks pass');
    expect(view.verdict).toBe('FAIL');
    expect(view.verdictTone).toBe('negative');
    expect(view.verdictNote).toBe("The attestation was not written by the oracle's signer.");
  });

  it('gives no signer note when the signer is wrong but a check also fails', () => {
    const view = verifyView(
      report({
        attestation: attestation({ signerOk: false, signer: OTHER_SIGNER }),
        checks: failing('doc_hash'),
      }),
      context(),
    );
    expect(view.verdict).toBe('FAIL');
    expect(view.verdictNote).toBeNull();
  });
});

describe('verifyView tier', () => {
  it.each([
    [1, 'A'],
    [2, 'B'],
    [3, 'C'],
  ] as const)('maps attestation tier %i to the letter %s with its tone', (tier, letter) => {
    const view = verifyView(report({ attestation: attestation({ tier }) }), context());
    expect(view.tier).toEqual({ letter, tone: tierTone(letter) });
  });
});

describe('verifyView checks', () => {
  it('lists the seven checks in library order with title, explanation and the library detail', () => {
    const { checks } = verifyView(report(), context());
    expect(checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
    expect(checks.map((c) => c.title)).toEqual(CHECKS.map((c) => c.title));
    for (const row of checks) {
      expect(row.detail).toBe(`detail of ${row.id}`);
      expect(row.explanation).toBe(CHECK_EXPLANATIONS[row.id]);
      expect(row.status).toBe('pass');
    }
  });

  it('marks only the failing checks as fail and keeps their detail', () => {
    const { checks } = verifyView(
      report({ checks: failing('compose_pcr16', 'entry_active') }),
      context(),
    );
    expect(checks.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual([
      'compose_pcr16',
      'entry_active',
    ]);
    expect(checks.find((c) => c.id === 'entry_active')?.detail).toBe('broken entry_active');
  });

  it.each(CHECKS.map((c) => c.id))('has a non-empty explanation for %s', (id) => {
    expect(CHECK_EXPLANATIONS[id].trim().length).toBeGreaterThan(0);
  });

  it('gives each check its own explanation', () => {
    expect(new Set(Object.values(CHECK_EXPLANATIONS)).size).toBe(CHECKS.length);
  });
});

describe('verifyView facts', () => {
  it('links the attestation to the explorer on the cluster and shows the build number', () => {
    const { facts } = verifyView(report(), context());
    expect(facts.attestation).toBe(ATTESTATION);
    expect(facts.explorer).toBe(explorerAddressUrl('devnet', ATTESTATION));
    expect(facts.build).toBe(1);
  });

  it('says the oracle signer wrote it when signerOk', () => {
    expect(verifyView(report(), context()).facts.writtenBy).toBe(
      'oracle signer ✓ (not a look-alike)',
    );
  });

  it('names a different signer and says it is not the oracle', () => {
    const { facts } = verifyView(
      report({ attestation: attestation({ signerOk: false, signer: OTHER_SIGNER }) }),
      context(),
    );
    expect(facts.writtenBy).toBe(`another signer ${shortAddress(OTHER_SIGNER)} — not the oracle`);
  });

  it('shortens the policy hash and formats both dates', () => {
    const { facts } = verifyView(report(), context());
    expect(facts.policy).toBe(shortHex(POLICY_HEX));
    expect(facts.issued).toBe(formatUnixDate(ISSUED_AT));
    expect(facts.expires).toBe(formatUnixDate(EXPIRY));
  });

  it.each([
    ['before the expiry', EXPIRY - 1n, false],
    // The pool lends strictly before `expiry` (FORMATS §14), so the expiry second is expired.
    ['exactly at the expiry', EXPIRY, true],
    ['after the expiry', EXPIRY + 1n, true],
  ])('is expired=%s only %s', (_, nowSeconds, expired) => {
    expect(verifyView(report(), context({ nowSeconds })).facts.expired).toBe(expired);
  });
});

describe('verifyView links', () => {
  it('points at the release tag, the archived file at the page release, and the registry entry', () => {
    const { links } = verifyView(report(), context());
    expect(links.release).toBe(`${REPO_URL}/releases/tag/v0.3.0`);
    expect(links.archive).toBe(`${REPO_URL}/blob/v0.5.0/deployments/devnet/attestation-1.hex`);
    expect(links.entry).toBe(explorerAddressUrl('devnet', ENTRY));
  });

  it('follows the page release for the archive link', () => {
    const { links } = verifyView(report(), context({ release: 'v9.9.9' }));
    expect(links.archive).toContain('/blob/v9.9.9/');
  });

  it('has no release or archive link for a build the deployment file does not list', () => {
    const view = verifyView(report({ attestation: attestation({ measurementId: 7 }) }), context());
    expect(view.links.release).toBeNull();
    expect(view.links.archive).toBeNull();
    expect(view.links.entry).toBe(explorerAddressUrl('devnet', ENTRY));
  });

  it('has an archive link but no release link for a record without a release tag', () => {
    const bare: Deployment = {
      ...deployment,
      enclaves: [
        {
          measurementId: 1,
          imageId: entry.imageId,
          attester: entry.attester,
          attestationFile: 'devnet/attestation-1.hex',
        },
      ],
    };
    const { links } = verifyView(report(), context({ deployment: bare }));
    expect(links.release).toBeNull();
    expect(links.archive).toBe(`${REPO_URL}/blob/v0.5.0/deployments/devnet/attestation-1.hex`);
  });
});

describe('parseWalletInput', () => {
  it('accepts a base58 address', () => {
    expect(parseWalletInput(WALLET)).toBe(WALLET);
  });

  it('trims surrounding whitespace', () => {
    expect(parseWalletInput(`  \n${WALLET}\t `)).toBe(WALLET);
  });

  it.each([
    ['empty text', ''],
    ['only whitespace', '   '],
    ['junk', 'junk'],
    // One character short can still decode to 32 bytes (a different, valid address); four cannot.
    ['an address with four characters cut off', WALLET.slice(4)],
    ['an address with an invalid base58 character (0)', `0${WALLET.slice(1)}`],
    ['two addresses', `${WALLET} ${ENTRY}`],
    ['a transaction-like long string', 'x'.repeat(100)],
  ])('rejects %s', (_, text) => {
    expect(parseWalletInput(text)).toBeNull();
  });
});
