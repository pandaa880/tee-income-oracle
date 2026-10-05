import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc as KitRpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  isSolanaError,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { Surfnet } from '@solana/surfpool';
import {
  fetchCredential,
  fetchMaybeCredential,
  fetchSchema,
  findAttestationPda,
  findCredentialPda,
  findSchemaPda,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
} from 'sas-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_NAME,
  PAYLOAD_LEN,
  SAS_PROGRAM_ID,
  SAS_SO_PATH,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
} from './sas-schema.ts';
import { SetupError, deriveSasSigner, runSasSetup } from './sas-setup.ts';

// SAS error code 5: signer not in the credential's authorized signers (FORMATS §7).
const SAS_UNAUTHORIZED_SIGNER = 5;
const ORACLE_PROGRAM_ID = 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8' as Address;

type Rpc = KitRpc<SolanaRpcApi>;
type Subs = RpcSubscriptions<SolanaRpcSubscriptionsApi>;

let surfnet: Surfnet;
let rpc: Rpc;
let rpcSubscriptions: Subs;
let admin: KeyPairSigner;

async function send(payer: KeyPairSigner, instructions: readonly Instruction[]): Promise<void> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(transaction);
  await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(transaction, {
    commitment: 'confirmed',
  });
}

function findCustomErrorCode(error: unknown): number | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (isSolanaError(current, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
      return current.context.code;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

async function pdas() {
  const [credential] = await findCredentialPda(
    { authority: admin.address, name: CREDENTIAL_NAME },
    { programAddress: SAS_PROGRAM_ID },
  );
  const [schema] = await findSchemaPda(
    { credential, name: SCHEMA_NAME, version: SCHEMA_VERSION },
    { programAddress: SAS_PROGRAM_ID },
  );
  return { credential, schema };
}

function run() {
  return runSasSetup({
    rpc,
    rpcSubscriptions,
    admin,
    oracleProgramId: ORACLE_PROGRAM_ID,
    cluster: 'localnet',
  });
}

// One surfnet per file: tests run in order and build on each other.
describe('runSasSetup on surfpool', () => {
  beforeAll(async () => {
    surfnet = Surfnet.start();
    surfnet.deploy({ programId: SAS_PROGRAM_ID, soPath: SAS_SO_PATH });
    admin = await createKeyPairSignerFromBytes(surfnet.payerSecretKey);
    rpc = createSolanaRpc(surfnet.rpcUrl);
    rpcSubscriptions = createSolanaRpcSubscriptions(surfnet.wsUrl);
  });

  afterAll(() => {
    surfnet.stop();
  });

  it('refuses_a_cluster_name_the_rpc_does_not_serve_and_sends_nothing', async () => {
    const failure = await runSasSetup({
      rpc,
      rpcSubscriptions,
      admin,
      oracleProgramId: ORACLE_PROGRAM_ID,
      cluster: 'devnet',
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SetupError);
    expect((failure as SetupError).code).toBe('cluster_mismatch');
    const { credential } = await pdas();
    expect((await fetchMaybeCredential(rpc, credential)).exists).toBe(false);
  });

  it('creates_credential_and_schema_on_first_run', async () => {
    const { created } = await run();
    expect(created).toEqual(['create_credential', 'create_schema']);
  });

  it('creates_nothing_on_second_run', async () => {
    const { created } = await run();
    expect(created).toEqual([]);
  });

  it('stores_credential_with_admin_authority_and_sas_signer', async () => {
    const { credential } = await pdas();
    const account = await fetchCredential(rpc, credential);
    const sasSigner = await deriveSasSigner(ORACLE_PROGRAM_ID);
    expect(account.data.authority).toBe(admin.address);
    expect(account.data.authorizedSigners).toEqual([sasSigner]);
    expect(new TextDecoder().decode(new Uint8Array(account.data.name))).toBe(CREDENTIAL_NAME);
  });

  it('stores_schema_with_layout_field_names_and_version', async () => {
    const { schema } = await pdas();
    const account = await fetchSchema(rpc, schema);
    expect(account.data.layout).toEqual([...SCHEMA_LAYOUT]);
    expect(account.data.fieldNames).toEqual([...SCHEMA_FIELD_NAMES]);
    expect(account.data.version).toBe(1);
    expect(account.data.isPaused).toBe(false);
  });

  it('returns_deployment_matching_derived_addresses', async () => {
    const { credential, schema } = await pdas();
    const { created, deployment } = await run();
    expect(created).toEqual([]);
    expect(deployment).toEqual({
      cluster: 'localnet',
      sas_program: SAS_PROGRAM_ID,
      oracle_program: ORACLE_PROGRAM_ID,
      sas_signer: await deriveSasSigner(ORACLE_PROGRAM_ID),
      authority: admin.address,
      credential,
      schema,
      schema_name: SCHEMA_NAME,
      schema_version: SCHEMA_VERSION,
    });
  });

  it('rejects_attestation_from_signer_outside_the_credential', async () => {
    const { credential, schema } = await pdas();
    const outsider = await generateKeyPairSigner();
    const nonce = (await generateKeyPairSigner()).address;
    const [attestation] = await findAttestationPda(
      { credential, schema, nonce },
      { programAddress: SAS_PROGRAM_ID },
    );
    const instruction = getCreateAttestationInstruction({
      payer: admin,
      authority: outsider,
      credential,
      schema,
      attestation,
      nonce,
      data: new Uint8Array(PAYLOAD_LEN),
      expiry: 0n,
    });
    const failure = await send(admin, [instruction]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    expect(findCustomErrorCode(failure)).toBe(SAS_UNAUTHORIZED_SIGNER);
  });
});

describe('runSasSetup against a conflicting credential on surfpool', () => {
  let conflictSurfnet: Surfnet;

  beforeAll(async () => {
    // Re-point the shared handles at a fresh surfnet so state is isolated.
    conflictSurfnet = Surfnet.start();
    conflictSurfnet.deploy({ programId: SAS_PROGRAM_ID, soPath: SAS_SO_PATH });
    admin = await createKeyPairSignerFromBytes(conflictSurfnet.payerSecretKey);
    rpc = createSolanaRpc(conflictSurfnet.rpcUrl);
    rpcSubscriptions = createSolanaRpcSubscriptions(conflictSurfnet.wsUrl);
  });

  afterAll(() => {
    conflictSurfnet.stop();
  });

  it('rejects_credential_with_a_different_signer_and_leaves_it_unchanged', async () => {
    const { credential } = await pdas();
    const wrongSigner = (await generateKeyPairSigner()).address;
    await send(admin, [
      getCreateCredentialInstruction({
        payer: admin,
        credential,
        authority: admin,
        name: CREDENTIAL_NAME,
        signers: [wrongSigner],
      }),
    ]);
    const before = await fetchCredential(rpc, credential);
    expect(before.data.authorizedSigners).toEqual([wrongSigner]);

    const failure = await run().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SetupError);
    expect((failure as SetupError).code).toBe('credential_signers_mismatch');

    const after = await fetchCredential(rpc, credential);
    expect(after.data.authorizedSigners).toEqual([wrongSigner]);
    expect(after.data.authority).toBe(admin.address);
  });
});
