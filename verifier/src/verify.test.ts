// verifyDocument (the seven checks, pure) and verifyWallet (chain + document) with a fake chain.
//
// Spec choices recorded here:
// - base_image cannot be the only failing check: PCR0-2 are covered by the COSE signature, so a
//   document with other PCR0 values also fails nitro_signature. That row pins exactly that pair.
// - EntryFacts: imageId and attestationDocHash are lowercase hex without prefix, attester is
//   0x-prefixed lowercase hex (the format of deployments/*.json).
// - A document that does not parse fails checks 1-6 with the parse error code in `detail`.
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex } from '@tio/encoding';
import { describe, expect, it } from 'vitest';
import {
  ATTESTER_HEX,
  IMAGE_ID_HEX,
  OTHER_ADDRESS,
  WALLET,
  entryOf,
  expectRejected,
  flipByteAt,
  joinCose,
  loadCompose,
  loadDocument,
  rawDocument,
  referenceImageId,
  splitCose,
  testDeployment,
  walletChain,
} from './test-fixtures.ts';
import { type CheckId, CHECKS } from './report.ts';
import { verifyDocument, verifyWallet } from './verify.ts';

const BOARD_ORDER: CheckId[] = [
  'nitro_signature',
  'base_image',
  'compose_pcr16',
  'image_id',
  'attester',
  'doc_hash',
  'entry_active',
];

type DocumentInput = Parameters<typeof verifyDocument>[0];
type Checks = ReturnType<typeof verifyDocument>;

const document1 = loadDocument(1);
const compose = loadCompose();
const baseInput = (): DocumentInput => ({
  document: document1,
  composeBytes: compose,
  entry: entryOf(1),
  proofType: 1,
});
const failing = (checks: Checks): CheckId[] =>
  checks.filter((c) => c.status === 'fail').map((c) => c.id);
const byId = (checks: Checks, id: CheckId) => checks.find((c) => c.id === id);

/** Entry fields consistent with a (modified) document: only its hash follows the bytes. */
const entryFor = (document: Uint8Array, rest: Parameters<typeof entryOf>[1] = {}) =>
  entryOf(1, { attestationDocHash: sha256(document), ...rest });

describe('CHECKS', () => {
  it('lists_the_seven_checks_in_board_order', () => {
    expect(CHECKS.map((c) => c.id)).toEqual(BOARD_ORDER);
  });

  it('uses_the_board_9_titles', () => {
    expect(CHECKS.map((c) => c.title)).toEqual([
      'Signed by AWS Nitro hardware',
      "Marlin's published base image, not debug mode",
      'Runs our published code',
      'Image id matches the registry',
      'Enclave key = on-chain attester',
      'Same document the registry recorded',
      'Entry is active',
    ]);
  });
});

describe('verifyDocument on the untouched fixtures', () => {
  it.each([0, 1] as const)('passes_all_seven_checks_for_document_%i', (id) => {
    const checks = verifyDocument({
      document: loadDocument(id),
      composeBytes: compose,
      entry: entryOf(id),
      proofType: 1,
    });
    expect(failing(checks)).toEqual([]);
    expect(checks).toHaveLength(7);
  });

  it('returns_checks_in_board_order_with_titles_and_details', () => {
    const checks = verifyDocument(baseInput());
    expect(checks.map((c) => c.id)).toEqual(BOARD_ORDER);
    expect(checks.map((c) => c.title)).toEqual(CHECKS.map((c) => c.title));
    expect(checks.every((c) => c.status === 'pass' && c.detail.length > 0)).toBe(true);
  });
});

describe('verifyDocument: one fault fails exactly one check', () => {
  const tamperedSignature = (() => {
    const parts = splitCose(document1);
    return joinCose({ ...parts, signature: flipByteAt(parts.signature, 10) });
  })();

  const rows: { fault: CheckId; input: () => DocumentInput }[] = [
    {
      fault: 'nitro_signature',
      input: () => ({
        ...baseInput(),
        document: tamperedSignature,
        entry: entryFor(tamperedSignature),
      }),
    },
    {
      fault: 'compose_pcr16',
      input: () => ({ ...baseInput(), composeBytes: flipByteAt(compose, 0) }),
    },
    {
      fault: 'image_id',
      input: () => ({
        ...baseInput(),
        entry: entryOf(1, { measurement: flipByteAt(Uint8Array.from(entryOf(1).measurement), 0) }),
      }),
    },
    {
      fault: 'attester',
      input: () => ({
        ...baseInput(),
        entry: entryOf(1, { attester: flipByteAt(Uint8Array.from(entryOf(1).attester), 0) }),
      }),
    },
    {
      fault: 'doc_hash',
      input: () => ({
        ...baseInput(),
        entry: entryOf(1, {
          attestationDocHash: flipByteAt(Uint8Array.from(entryOf(1).attestationDocHash), 0),
        }),
      }),
    },
    {
      fault: 'entry_active',
      input: () => ({ ...baseInput(), entry: entryOf(1, { revokedAt: 1n }) }),
    },
    {
      fault: 'entry_active',
      input: () => ({ ...baseInput(), entry: entryOf(1, { measurementKind: 2 }) }),
    },
    { fault: 'entry_active', input: () => ({ ...baseInput(), proofType: 2 }) },
  ];

  it.each(rows.map((row, i) => [`${row.fault}#${i}`, row] as const))('%s', (_name, row) => {
    expect(failing(verifyDocument(baseInput()))).toEqual([]);
    const checks = verifyDocument(row.input());
    expect(failing(checks)).toEqual([row.fault]);
    expect(checks.map((c) => c.id)).toEqual(BOARD_ORDER);
    expect(byId(checks, row.fault)?.detail.length).toBeGreaterThan(0);
  });

  it('omitting_the_compose_fails_only_compose_pcr16', () => {
    const withoutCompose: DocumentInput = {
      document: document1,
      entry: entryOf(1),
      proofType: 1,
    };
    expect(failing(verifyDocument(baseInput()))).toEqual([]);
    expect(failing(verifyDocument(withoutCompose))).toEqual(['compose_pcr16']);
  });

  // One row per pinned PCR, so deleting any one comparison in base_image turns a row red (§5).
  it.each([0, 1, 2])('a_different_pcr%i_fails_base_image_and_the_signature_over_it', (index) => {
    const raw = rawDocument(1);
    const pcr = raw.pcrs.get(index) ?? new Uint8Array();
    const payload = Uint8Array.from(raw.cose.payload);
    const at = Buffer.from(payload).indexOf(Buffer.from(pcr));
    expect(at).toBeGreaterThan(0);
    payload[at] = (payload[at] ?? 0) ^ 1;
    const document = joinCose({ ...raw.cose, payload });
    const pcrs = new Map(raw.pcrs);
    pcrs.set(index, Uint8Array.from(payload.subarray(at, at + 48)));
    const entry = entryFor(document, { measurement: referenceImageId(pcrs) });
    const checks = verifyDocument({ ...baseInput(), document, entry });
    expect(failing(checks)).toEqual(['nitro_signature', 'base_image']);
    expect(byId(checks, 'base_image')?.detail).toContain(`PCR${index}`);
  });
});

describe('verifyDocument: faults do not short-circuit', () => {
  it('two_faults_fail_both_checks_and_nothing_else', () => {
    const entry = entryOf(1, {
      attester: new Uint8Array(20).fill(1),
      revokedAt: 5n,
    });
    expect(failing(verifyDocument({ ...baseInput(), entry }))).toEqual([
      'attester',
      'entry_active',
    ]);
  });

  it('the_first_and_the_last_check_can_fail_together', () => {
    const parts = splitCose(document1);
    const tampered = joinCose({ ...parts, signature: flipByteAt(parts.signature, 3) });
    const entry = entryFor(tampered, { revokedAt: 5n });
    expect(failing(verifyDocument({ ...baseInput(), document: tampered, entry }))).toEqual([
      'nitro_signature',
      'entry_active',
    ]);
  });

  it('an_unparsable_document_fails_checks_1_to_6_with_the_parse_error_code_and_passes_entry_active', () => {
    // even when the entry's hash matches the truncated bytes: no parse, no check 1-6
    const truncated = document1.subarray(0, 10);
    const checks = verifyDocument({
      ...baseInput(),
      document: truncated,
      entry: entryFor(truncated),
    });
    expect(failing(checks)).toEqual(BOARD_ORDER.slice(0, 6));
    for (const check of checks.slice(0, 6)) {
      expect(check.detail).toContain('cose_malformed');
    }
    expect(byId(checks, 'entry_active')?.status).toBe('pass');
  });

  it('an_unparsable_document_with_a_revoked_entry_fails_all_seven', () => {
    const checks = verifyDocument({
      ...baseInput(),
      document: document1.subarray(0, 10),
      entry: entryOf(1, { revokedAt: 5n }),
    });
    expect(failing(checks)).toEqual(BOARD_ORDER);
  });
});

describe('verifyDocument: details carry no upstream text', () => {
  it('passing_details_hold_hex_ids_and_dates_only', () => {
    const checks = verifyDocument(baseInput());
    expect(byId(checks, 'image_id')?.detail).toContain(IMAGE_ID_HEX);
    expect(byId(checks, 'attester')?.detail.toLowerCase()).toContain(ATTESTER_HEX[1].slice(2));
    expect(byId(checks, 'doc_hash')?.detail).toContain(toHex(sha256(document1)));
  });
});

async function run(
  options: Parameters<typeof walletChain>[1] = {},
  overrides: { document?: Uint8Array; composeBytes?: Uint8Array | null } = {},
) {
  const { chain } = await walletChain(1, options);
  const deployment = options.deployment ?? (await testDeployment());
  const input = {
    chain,
    deployment,
    wallet: WALLET,
    document: overrides.document ?? document1,
    ...(overrides.composeBytes === null ? {} : { composeBytes: overrides.composeBytes ?? compose }),
  };
  return verifyWallet(input);
}

describe('verifyWallet', () => {
  it('passes_with_seven_passing_checks_in_board_order', async () => {
    const report = await run();
    expect(report.verdict).toBe('PASS');
    expect(report.checks.map((c) => c.id)).toEqual(BOARD_ORDER);
    expect(failing(report.checks)).toEqual([]);
    expect(report.wallet).toBe(WALLET);
  });

  it('reports_the_attestation_and_entry_facts', async () => {
    const report = await run();
    expect(report.attestation).toMatchObject({ measurementId: 1, signerOk: true, proofType: 1 });
    expect(report.entry).toMatchObject({
      measurementId: 1,
      measurementKind: 1,
      imageId: IMAGE_ID_HEX,
      attester: ATTESTER_HEX[1],
      attestationDocHash: toHex(sha256(document1)),
      revokedAt: 0n,
    });
  });

  it('reads_the_entry_named_by_the_attestations_measurement_id', async () => {
    const { chain } = await walletChain(0);
    const deployment = await testDeployment();
    const report = await verifyWallet({
      chain,
      deployment,
      wallet: WALLET,
      document: loadDocument(0),
      composeBytes: compose,
    });
    expect(report.verdict).toBe('PASS');
    expect(report.entry.attester).toBe(ATTESTER_HEX[0]);
  });

  it('fails_the_verdict_when_the_entry_is_revoked', async () => {
    expect((await run()).verdict).toBe('PASS');
    const report = await run({ entry: { revokedAt: 99n } });
    expect(report.verdict).toBe('FAIL');
    expect(failing(report.checks)).toEqual(['entry_active']);
  });

  it('fails_only_compose_pcr16_without_compose_bytes', async () => {
    const report = await run({}, { composeBytes: null });
    expect(report.verdict).toBe('FAIL');
    expect(failing(report.checks)).toEqual(['compose_pcr16']);
  });

  it('fails_the_verdict_for_a_signer_that_is_not_the_sas_signer_with_all_checks_passing', async () => {
    // Review round 1: only the oracle's sas_signer ties the tier to the entry's precompile check,
    // so an attestation by any other signer is FAIL even though the seven checks say nothing.
    expect((await run()).verdict).toBe('PASS');
    const report = await run({ signer: OTHER_ADDRESS });
    expect(report.attestation.signerOk).toBe(false);
    expect(failing(report.checks)).toEqual([]);
    expect(report.verdict).toBe('FAIL');
  });

  it('rejects_a_deployment_whose_sas_signer_is_not_the_oracles_pda', async () => {
    const deployment = await testDeployment({ sasSigner: OTHER_ADDRESS });
    const { chain } = await walletChain(1, { deployment });
    await expectRejected(
      verifyWallet({
        chain,
        deployment,
        wallet: WALLET,
        document: document1,
        composeBytes: compose,
      }),
      'deployment_malformed',
    );
  });

  it('loads_the_document_and_the_compose_from_sources_given_the_measurement_id', async () => {
    const { chain } = await walletChain(1);
    const asked: number[] = [];
    const report = await verifyWallet({
      chain,
      deployment: await testDeployment(),
      wallet: WALLET,
      document: async (id) => {
        asked.push(id);
        return document1;
      },
      composeBytes: async (id) => {
        asked.push(id);
        return compose;
      },
    });
    expect(asked).toEqual([1, 1]);
    expect(report.verdict).toBe('PASS');
  });

  it('turns_a_failing_document_source_into_fetch_failed', async () => {
    const { chain } = await walletChain(1);
    await expectRejected(
      verifyWallet({
        chain,
        deployment: await testDeployment(),
        wallet: WALLET,
        document: async () => {
          throw new Error('disk on fire');
        },
      }),
      'fetch_failed',
    );
  });

  it('fails_checks_1_to_6_for_an_unparsable_document_and_passes_entry_active', async () => {
    const report = await run({}, { document: document1.subarray(0, 10) });
    expect(report.verdict).toBe('FAIL');
    expect(failing(report.checks)).toEqual(BOARD_ORDER.slice(0, 6));
  });

  it('fails_the_verdict_for_a_document_the_registry_did_not_record', async () => {
    const report = await run({}, { document: loadDocument(0) });
    expect(report.verdict).toBe('FAIL');
    expect(failing(report.checks)).toContain('doc_hash');
  });

  it('rejects_a_wallet_without_an_attestation', async () => {
    const { chain } = await walletChain(1);
    await expectRejected(
      verifyWallet({
        chain,
        deployment: await testDeployment(),
        wallet: OTHER_ADDRESS,
        document: document1,
        composeBytes: compose,
      }),
      'attestation_missing',
    );
  });

  it('rejects_an_attestation_whose_entry_is_not_on_chain', async () => {
    const { chain } = await walletChain(1, { withEntry: false });
    await expectRejected(
      verifyWallet({
        chain,
        deployment: await testDeployment(),
        wallet: WALLET,
        document: document1,
        composeBytes: compose,
      }),
      'entry_missing',
    );
  });
});
