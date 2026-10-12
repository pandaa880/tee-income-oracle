/**
 * The borrower's SAS attestation (FORMATS §7): derived from the wallet, read raw,
 * decoded with the same checks the demo pool makes (owner, 256 bytes,
 * discriminator 2, 83-byte payload) and compared against the oracle's
 * `sas_signer` PDA. Only that signer writes through the oracle's precompile
 * check, so an attestation by any other signer is not one the oracle vouches
 * for, however well-formed its payload (`signerOk` fails the verdict).
 */
import type { Address } from '@solana/kit';
import { findSasSignerPda } from '@tio/oracle-client';
import {
  type DecodedPayload,
  attestationAddress,
  decodePayload,
  parseSasAttestation,
} from '@tio/oracle-client/attest';
import type { Deployment } from '../deployment.ts';
import { VerifierError } from '../errors.ts';
import type { ChainReader } from './ports.ts';

export type AttestationFacts = DecodedPayload & {
  address: Address;
  signer: Address;
  /** `signer` is the oracle's `sas_signer` PDA (the only signer the oracle writes through). */
  signerOk: boolean;
  /** SAS expiry (unix seconds). */
  expiry: bigint;
};

/**
 * The `sas_signer` PDA of the deployment's oracle program, derived here rather
 * than read from the file: a deployment file is public data anyone can serve.
 *
 * @throws VerifierError `deployment_malformed` if the file's `sas_signer` differs.
 */
export async function sasSignerOf(deployment: Deployment): Promise<Address> {
  const [derived] = await findSasSignerPda({ programAddress: deployment.oracleProgram });
  if (derived !== deployment.sasSigner) {
    throw new VerifierError(
      'deployment_malformed',
      `sas_signer ${deployment.sasSigner} is not the oracle's PDA ${derived}`,
    );
  }
  return derived;
}

/** @throws VerifierError `attestation_missing` | `attestation_malformed` | `deployment_malformed` */
export async function readAttestation(
  chain: ChainReader,
  deployment: Deployment,
  wallet: Address,
): Promise<AttestationFacts> {
  const sasSigner = await sasSignerOf(deployment);
  const address = await attestationAddress(deployment.credential, deployment.schema, wallet);
  const account = await chain.account(address);
  if (account === null) {
    throw new VerifierError('attestation_missing', `no attestation at ${address} for ${wallet}`);
  }
  try {
    const stored = parseSasAttestation(account.owner, account.data);
    const payload = decodePayload(stored.payload);
    // FORMATS §7: tiers are 1–3; REJECT is never written, so anything else is not ours.
    if (payload.tier < 1 || payload.tier > 3)
      throw new Error(`payload tier ${payload.tier} is not 1, 2 or 3`);
    return {
      ...payload,
      address,
      signer: stored.signer,
      signerOk: stored.signer === sasSigner,
      expiry: stored.expiry,
    };
  } catch (error) {
    throw new VerifierError(
      'attestation_malformed',
      error instanceof Error ? error.message : 'attestation account is not readable',
    );
  }
}
