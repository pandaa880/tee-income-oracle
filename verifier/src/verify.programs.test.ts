// verifyWallet and the CLI against the real oracle and SAS programs on an embedded surfnet.
// Needs `anchor build`. The SAS attestation is planted (signer = the oracle's sas_signer PDA);
// the EnclaveEntry is registered through the real `register_enclave` with document-1 facts.
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sha256 } from '@noble/hashes/sha2.js';
import { type Address, generateKeyPairSigner } from '@solana/kit';
import { fromHex } from '@tio/encoding';
import { ORACLE_PROGRAM_ADDRESS, findSasSignerPda } from '@tio/oracle-client';
import { SAS_PROGRAM_ID, attestationAddress } from '@tio/oracle-client/attest';
import { buildPayload, plantAccount } from '@tio/oracle-tests/attest';
import {
  type Harness,
  initializeOracle,
  registerIx,
  revokeIx,
  send,
  startHarness,
  validEnclave,
} from '@tio/oracle-tests/harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitChainReader } from './chain/kit.ts';
import { type Deployment } from './deployment.ts';
import {
  ATTESTER_HEX,
  COMPOSE_PATH,
  DOCUMENT_HEX_PATH,
  IMAGE_ID_HEX,
  ISSUED_AT,
  loadCompose,
  loadDocument,
  loadDocumentHex,
  sasAttestationAccount,
} from './test-fixtures.ts';
import { verifyWallet } from './verify.ts';

const VERIFIER_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENTRY_ID = 0;
const run = promisify(execFile);

let h: Harness;
let deployment: Deployment;
let wallet: Address;
let dir: string;
let deploymentPath: string;
let docPath: string;

type Cli = { code: number; stdout: string; stderr: string };

async function cli(
  walletAddress: Address,
  extra: string[] = [],
  options: { deployment?: string; compose?: boolean } = {},
): Promise<Cli> {
  const args = [
    '--import',
    'tsx',
    'src/cli.ts',
    walletAddress,
    '--cluster',
    'localnet',
    '--deployment',
    options.deployment ?? deploymentPath,
    '--rpc',
    h.surfnet.rpcUrl,
    ...(options.compose === false ? [] : ['--compose', COMPOSE_PATH]),
    ...extra,
  ];
  try {
    const { stdout, stderr } = await run(process.execPath, args, { cwd: VERIFIER_DIR });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const linesStartingWith = (text: string, prefix: string): string[] =>
  text.split('\n').filter((line) => line.startsWith(prefix));

beforeAll(async () => {
  h = await startHarness({ sas: true });
  if (h.sas === undefined) throw new Error('harness started without SAS');
  await initializeOracle(h);
  const document = loadDocument(1);
  await send(h, h.admin, [
    await registerIx(
      h,
      ENTRY_ID,
      validEnclave({
        measurement: fromHex(IMAGE_ID_HEX),
        attester: fromHex(ATTESTER_HEX[1].slice(2)),
        attestationDocHash: sha256(document),
      }),
    ),
  ]);

  const [sasSigner] = await findSasSignerPda();
  deployment = {
    cluster: 'localnet',
    oracleProgram: ORACLE_PROGRAM_ADDRESS,
    sasProgram: SAS_PROGRAM_ID,
    credential: h.sas.credential,
    schema: h.sas.schema,
    sasSigner,
    enclaves: [],
  };
  wallet = (await generateKeyPairSigner()).address;
  plantAccount(
    h,
    await attestationAddress(h.sas.credential, h.sas.schema, wallet),
    SAS_PROGRAM_ID,
    sasAttestationAccount({
      wallet,
      credential: h.sas.credential,
      schema: h.sas.schema,
      signer: sasSigner,
      payload: buildPayload({ issuedAt: ISSUED_AT, measurementId: ENTRY_ID }),
    }),
  );

  dir = await mkdtemp(join(tmpdir(), 'verifier-'));
  deploymentPath = join(dir, 'localnet.json');
  docPath = join(dir, 'attestation-0.hex');
  await copyFile(DOCUMENT_HEX_PATH(1), docPath);
  await writeDeployment(deploymentPath, {});
});

/** A deployment file for the surfnet whose single enclave record carries `recordExtra`. */
async function writeDeployment(path: string, recordExtra: Record<string, unknown>): Promise<void> {
  if (h.sas === undefined) throw new Error('harness started without SAS');
  const [sasSigner] = await findSasSignerPda();
  await writeFile(
    path,
    `${JSON.stringify(
      {
        cluster: 'localnet',
        sas_program: SAS_PROGRAM_ID,
        oracle_program: ORACLE_PROGRAM_ADDRESS,
        sas_signer: sasSigner,
        authority: h.admin.address,
        credential: h.sas.credential,
        schema: h.sas.schema,
        schema_name: 'tio-income-tier',
        schema_version: 1,
        enclaves: [
          {
            measurement_id: ENTRY_ID,
            image_id: IMAGE_ID_HEX,
            attester: ATTESTER_HEX[1],
            attestation_file: 'attestation-0.hex',
            ...recordExtra,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

afterAll(async () => {
  h.surfnet.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('verifyWallet against the real programs', () => {
  it('passes_all_seven_checks_for_a_registered_entry_and_a_planted_attestation', async () => {
    const report = await verifyWallet({
      chain: kitChainReader(h.rpc),
      deployment,
      wallet,
      document: loadDocument(1),
      composeBytes: loadCompose(),
    });
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(report.verdict).toBe('PASS');
    expect(report.attestation.signerOk).toBe(true);
    expect(report.entry).toMatchObject({ measurementId: ENTRY_ID, revokedAt: 0n });
  });
});

describe('tio-verify CLI against the surfnet', () => {
  it('prints_seven_pass_lines_and_exits_0', async () => {
    const result = await cli(wallet, ['--doc', docPath]);
    expect(result.stderr).toBe('');
    expect(linesStartingWith(result.stdout, 'PASS')).toHaveLength(7);
    expect(linesStartingWith(result.stdout, 'FAIL')).toHaveLength(0);
    expect(linesStartingWith(result.stdout, 'VERDICT')).toEqual(['VERDICT PASS']);
    expect(result.code).toBe(0);
  });

  it('uses_the_archived_document_of_the_deployment_record_without_doc', async () => {
    const result = await cli(wallet);
    expect(linesStartingWith(result.stdout, 'PASS')).toHaveLength(7);
    expect(result.code).toBe(0);
  });

  it('exits_2_without_compose_when_the_record_names_no_release', async () => {
    // The default compose comes from the record's release tag; this record has none.
    const result = await cli(wallet, [], { compose: false });
    expect(result.stderr).toContain('error: deployment_malformed:');
    expect(result.stderr).toContain('--compose');
    expect(result.code).toBe(2);
  });

  it('exits_2_with_file_unreadable_when_the_release_tag_is_not_in_the_clone', async () => {
    const path = join(dir, 'localnet-v999.json');
    await writeDeployment(path, { release: 'v999.0.0' });
    const result = await cli(wallet, [], { deployment: path, compose: false });
    expect(result.stderr).toContain('error: file_unreadable:');
    expect(result.code).toBe(2);
  });

  it('exits_2_with_a_usage_error_for_an_unknown_option', async () => {
    const result = await cli(wallet, ['--live']);
    expect(result.stderr).toMatch(/^error: usage: /);
    expect(result.code).toBe(2);
  });

  it('exits_1_with_a_fail_line_for_a_document_with_one_flipped_payload_byte', async () => {
    const hex = loadDocumentHex(1);
    const middle = Math.floor(hex.length / 4) * 2;
    const flipped = hex[middle] === '0' ? '1' : '0';
    const tampered = join(dir, 'tampered.hex');
    await writeFile(tampered, `${hex.slice(0, middle)}${flipped}${hex.slice(middle + 1)}\n`);
    // Baseline: the untampered copy is byte-for-byte the archive (which has no trailing newline).
    expect((await readFile(docPath, 'utf8')).trim()).toBe(hex);
    const result = await cli(wallet, ['--doc', tampered]);
    expect(linesStartingWith(result.stdout, 'FAIL').length).toBeGreaterThan(0);
    expect(linesStartingWith(result.stdout, 'VERDICT')).toEqual(['VERDICT FAIL']);
    expect(result.code).toBe(1);
  });

  it('exits_2_with_attestation_missing_for_a_wallet_without_an_attestation', async () => {
    const unknown = (await generateKeyPairSigner()).address;
    const result = await cli(unknown, ['--doc', docPath]);
    expect(result.stderr).toContain('attestation_missing');
    expect(result.code).toBe(2);
  });
});

describe('after revoke_enclave', () => {
  it('fails_only_entry_active', async () => {
    await send(h, h.admin, [await revokeIx(h, ENTRY_ID)]);
    const report = await verifyWallet({
      chain: kitChainReader(h.rpc),
      deployment,
      wallet,
      document: loadDocument(1),
      composeBytes: loadCompose(),
    });
    expect(report.checks.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual([
      'entry_active',
    ]);
    expect(report.verdict).toBe('FAIL');
    expect(report.entry.revokedAt).toBeGreaterThan(0n);
  });

  it('makes_the_cli_exit_1', async () => {
    const result = await cli(wallet, ['--doc', docPath]);
    expect(linesStartingWith(result.stdout, 'FAIL')).toHaveLength(1);
    expect(result.code).toBe(1);
  });
});
