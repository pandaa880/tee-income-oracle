import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from '@solana/kit';
import {
  fetchMaybeCredential,
  fetchMaybeSchema,
  findCredentialPda,
  findSchemaPda,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
} from 'sas-lib';
import { type Cluster, checkCluster } from './cluster.ts';
import { type SetupErrorCode, type SetupStep, planSasSetup } from './plan-setup.ts';
import {
  CREDENTIAL_NAME,
  SAS_PROGRAM_ID,
  SCHEMA_DESCRIPTION,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
} from './sas-schema.ts';
import { sendInstructions } from './send.ts';

/** Public addresses written to `deployments/<cluster>.json`. */
export type Deployment = {
  cluster: Cluster;
  sas_program: string;
  oracle_program: string;
  sas_signer: string;
  authority: string;
  credential: string;
  schema: string;
  schema_name: string;
  schema_version: number;
};

export type SetupFailureCode = SetupErrorCode | 'cluster_mismatch';

export class SetupError extends Error {
  readonly code: SetupFailureCode;

  constructor(code: SetupFailureCode, message: string) {
    super(message);
    this.name = 'SetupError';
    this.code = code;
  }
}

export type SetupInput = {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  admin: KeyPairSigner;
  oracleProgramId: Address;
  cluster: Cluster;
};

/**
 * The oracle program's SAS signing PDA, `["sas_signer"]`. It has no private
 * key, so only oracle program logic can sign attestations with it (3c).
 */
export async function deriveSasSigner(oracleProgramId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: oracleProgramId,
    seeds: [getUtf8Encoder().encode('sas_signer')],
  });
  return pda;
}

/**
 * Create the SAS credential and schema if missing, or verify the existing
 * ones. Safe to re-run: a second run sends nothing.
 *
 * @throws SetupError if the RPC isn't the named cluster, or an existing
 *   account doesn't match. Nothing is sent in either case.
 */
export async function runSasSetup(
  input: SetupInput,
): Promise<{ created: SetupStep[]; deployment: Deployment }> {
  const { rpc, admin, oracleProgramId } = input;
  // First, before reading or sending anything: a run named `localnet` must
  // never write to a public cluster, and its deployments file must be true.
  const check = checkCluster(input.cluster, await rpc.getGenesisHash().send());
  if (!check.ok) throw new SetupError(check.error.code, check.error.message);

  const sasSigner = await deriveSasSigner(oracleProgramId);
  const { credential, schema } = await findSetupPdas(admin.address);
  const [foundCredential, foundSchema] = await Promise.all([
    fetchMaybeCredential(rpc, credential),
    fetchMaybeSchema(rpc, schema),
  ]);
  const plan = planSasSetup(
    {
      credential: foundCredential.exists ? foundCredential.data : null,
      schema: foundSchema.exists ? foundSchema.data : null,
    },
    { authority: admin.address, sasSigner },
  );
  if (!plan.ok) throw new SetupError(plan.error.code, plan.error.message);

  const instructions = plan.steps.map((step) =>
    buildInstruction(step, { admin, credential, schema, sasSigner }),
  );
  if (instructions.length > 0) await sendInstructions(input, admin, instructions);

  return {
    created: plan.steps,
    deployment: {
      cluster: input.cluster,
      sas_program: SAS_PROGRAM_ID,
      oracle_program: oracleProgramId,
      sas_signer: sasSigner,
      authority: admin.address,
      credential,
      schema,
      schema_name: SCHEMA_NAME,
      schema_version: SCHEMA_VERSION,
    },
  };
}

function buildInstruction(
  step: SetupStep,
  accounts: { admin: KeyPairSigner; credential: Address; schema: Address; sasSigner: Address },
): Instruction {
  const { admin, credential, schema, sasSigner } = accounts;
  // Pin the program address rather than trust sas-lib's generated default.
  const config = { programAddress: SAS_PROGRAM_ID };
  if (step === 'create_credential') {
    return getCreateCredentialInstruction(
      { payer: admin, credential, authority: admin, name: CREDENTIAL_NAME, signers: [sasSigner] },
      config,
    );
  }
  return getCreateSchemaInstruction(
    {
      payer: admin,
      authority: admin,
      credential,
      schema,
      name: SCHEMA_NAME,
      description: SCHEMA_DESCRIPTION,
      layout: [...SCHEMA_LAYOUT],
      fieldNames: [...SCHEMA_FIELD_NAMES],
    },
    config,
  );
}

async function findSetupPdas(
  authority: Address,
): Promise<{ credential: Address; schema: Address }> {
  const config = { programAddress: SAS_PROGRAM_ID };
  const [credential] = await findCredentialPda({ authority, name: CREDENTIAL_NAME }, config);
  const [schema] = await findSchemaPda(
    { credential, name: SCHEMA_NAME, version: SCHEMA_VERSION },
    config,
  );
  return { credential, schema };
}
