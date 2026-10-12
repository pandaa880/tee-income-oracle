/**
 * `deployments/<cluster>.json` (FORMATS §7, "Deployment file"), validated with
 * zod: the addresses the verifier derives PDAs from, and the enclave records
 * that say where each registered build's archived document and compose tag are.
 * Snake_case on disk, camelCase here.
 *
 * The file is not trusted for anything the code can know itself: the program
 * ids must equal the ones compiled into `@tio/oracle-client`, and `sas_signer`
 * is re-derived from the oracle program before it is used (`chain/attestation.ts`).
 */
import { type Address, isAddress } from '@solana/kit';
import { ORACLE_PROGRAM_ID, SAS_PROGRAM_ID } from '@tio/oracle-client/attest';
import { z } from 'zod';
import { VerifierError } from './errors.ts';

export type EnclaveRecord = {
  measurementId: number;
  /** Hex image id (FORMATS §13 `measurement`). */
  imageId: string;
  /** `0x` + 20 bytes hex. */
  attester: string;
  /** Path of the archived document, relative to the deployment file. */
  attestationFile: string;
  /** Git tag whose `enclave/docker-compose.yml` produced the image. */
  release?: string;
  /** The enclave's attestation server, `http://<ip>:1301`; absent once the enclave is gone. */
  endpoint?: string;
};

export type Deployment = {
  cluster: string;
  oracleProgram: Address;
  sasProgram: Address;
  credential: Address;
  schema: Address;
  sasSigner: Address;
  enclaves: EnclaveRecord[];
};

const AddressSchema = z.string().refine(isAddress, 'not a base58 address');

const RecordSchema = z.object({
  measurement_id: z.int().min(0).max(255),
  image_id: z.string().regex(/^[0-9a-f]{64}$/, 'not 32 bytes of lowercase hex'),
  attester: z.string().regex(/^0x[0-9a-f]{40}$/, 'not a 0x eth address'),
  attestation_file: z.string().min(1),
  release: z
    .string()
    .regex(/^v\d+\.\d+\.\d+$/, 'not a release tag')
    .optional(),
  endpoint: z.url({ protocol: /^https?$/ }).optional(),
});

const DeploymentSchema = z.object({
  cluster: z.string().min(1),
  oracle_program: z.literal(ORACLE_PROGRAM_ID, 'not the oracle program this client is built for'),
  sas_program: z.literal(SAS_PROGRAM_ID, 'not the SAS program this client is built for'),
  credential: AddressSchema,
  schema: AddressSchema,
  sas_signer: AddressSchema,
  enclaves: z.array(RecordSchema).default([]),
});

/** @throws VerifierError `deployment_malformed` */
export function parseDeployment(json: unknown): Deployment {
  const parsed = DeploymentSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new VerifierError(
      'deployment_malformed',
      `deployment file: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`,
    );
  }
  const d = parsed.data;
  return {
    cluster: d.cluster,
    oracleProgram: d.oracle_program,
    sasProgram: d.sas_program,
    credential: d.credential,
    schema: d.schema,
    sasSigner: d.sas_signer,
    enclaves: d.enclaves.map((e) => ({
      measurementId: e.measurement_id,
      imageId: e.image_id,
      attester: e.attester,
      attestationFile: e.attestation_file,
      ...(e.release === undefined ? {} : { release: e.release }),
      ...(e.endpoint === undefined ? {} : { endpoint: e.endpoint }),
    })),
  };
}

/** The record of a registered build, or undefined if the file has none for `measurementId`. */
export function enclaveRecordOf(d: Deployment, measurementId: number): EnclaveRecord | undefined {
  return d.enclaves.find((e) => e.measurementId === measurementId);
}
