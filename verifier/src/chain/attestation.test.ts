// readAttestation: the SAS attestation account of a wallet, read through a fake ChainReader.
import { type Address } from '@solana/kit';
import { SAS_ATTESTATION_LEN, SAS_PROGRAM_ID } from '@tio/oracle-client/attest';
import { buildPayload } from '@tio/oracle-tests/attest';
import { describe, expect, it } from 'vitest';
import {
  ISSUED_AT,
  OTHER_ADDRESS,
  WALLET,
  expectBaselineSucceeds,
  expectRejected,
  fakeChain,
  testDeployment,
  walletChain,
} from '../test-fixtures.ts';
import { readAttestation } from './attestation.ts';

describe('readAttestation', () => {
  it('returns_the_payload_fields_the_address_the_signer_and_the_expiry', async () => {
    const deployment = await testDeployment();
    const { chain, attestationAddress } = await walletChain(1, {
      payload: { tier: 2, proofType: 1, measurementId: 1 },
    });
    const facts = await readAttestation(chain, deployment, WALLET);
    expect(facts).toMatchObject({
      tier: 2,
      proofType: 1,
      measurementId: 1,
      issuedAt: ISSUED_AT,
      windowFrom: 1_758_844_800,
      windowTo: 1_790_380_800,
      address: attestationAddress,
      signer: deployment.sasSigner,
      signerOk: true,
      expiry: ISSUED_AT + 600n,
    });
    expect(facts.policyHash).toEqual(new Uint8Array(32).fill(0x11));
    expect(facts.consentHash).toEqual(new Uint8Array(32).fill(0x22));
  });

  it('round_trips_the_payload_the_oracle_tests_build', async () => {
    const payload = {
      tier: 3 as const,
      proofType: 1,
      measurementId: 4,
      policyHash: new Uint8Array(32).fill(7),
      consentHash: new Uint8Array(32).fill(9),
      issuedAt: 1_791_000_000n,
      windowFrom: 11,
      windowTo: 22,
    };
    expect(buildPayload(payload)).toHaveLength(83);
    const { chain } = await walletChain(1, { payload });
    expect(await readAttestation(chain, await testDeployment(), WALLET)).toMatchObject(payload);
  });

  it('reports_signer_not_ok_when_the_signer_is_not_the_sas_signer_pda', async () => {
    const { chain } = await walletChain(1, { signer: OTHER_ADDRESS });
    const facts = await readAttestation(chain, await testDeployment(), WALLET);
    expect(facts.signerOk).toBe(false);
    expect(facts.signer).toBe(OTHER_ADDRESS);
  });

  it('rejects_a_wallet_without_an_attestation_as_attestation_missing', async () => {
    await expectRejected(
      readAttestation(fakeChain(new Map()), await testDeployment(), WALLET),
      'attestation_missing',
    );
  });

  it('does_not_find_the_attestation_of_another_wallet', async () => {
    const { chain } = await walletChain(1);
    const deployment = await testDeployment();
    expect((await readAttestation(chain, deployment, WALLET)).signerOk).toBe(true);
    await expectRejected(readAttestation(chain, deployment, OTHER_ADDRESS), 'attestation_missing');
  });
});

async function plantedWith(
  change: (account: { owner: Address; data: Uint8Array }) => { owner: Address; data: Uint8Array },
) {
  const deployment = await testDeployment();
  const { accounts, attestationAddress } = await walletChain(1);
  const original = accounts.get(attestationAddress);
  if (original === undefined) throw new Error('fixture account missing');
  expectBaselineSucceeds(() => original);
  accounts.set(attestationAddress, change({ owner: original.owner, data: original.data.slice() }));
  return { chain: fakeChain(accounts), deployment };
}

describe('readAttestation rejects a malformed account as attestation_malformed', () => {
  it('owner_is_not_sas', async () => {
    const { chain, deployment } = await plantedWith((a) => ({ ...a, owner: OTHER_ADDRESS }));
    await expectRejected(readAttestation(chain, deployment, WALLET), 'attestation_malformed');
  });

  it('length_is_255', async () => {
    const { chain, deployment } = await plantedWith((a) => ({
      ...a,
      data: a.data.subarray(0, 255),
    }));
    await expectRejected(readAttestation(chain, deployment, WALLET), 'attestation_malformed');
  });

  it('length_is_257', async () => {
    const { chain, deployment } = await plantedWith((a) => ({
      ...a,
      data: Uint8Array.from([...a.data, 0]),
    }));
    await expectRejected(readAttestation(chain, deployment, WALLET), 'attestation_malformed');
  });

  it('discriminator_is_not_2', async () => {
    const { chain, deployment } = await plantedWith((a) => {
      a.data[0] = 1;
      return a;
    });
    await expectRejected(readAttestation(chain, deployment, WALLET), 'attestation_malformed');
  });

  it('data_length_field_is_not_83', async () => {
    const { chain, deployment } = await plantedWith((a) => {
      new DataView(a.data.buffer).setUint32(97, 82, true);
      return a;
    });
    await expectRejected(readAttestation(chain, deployment, WALLET), 'attestation_malformed');
  });

  it('tier_is_not_1_2_or_3', async () => {
    const { chain, deployment } = await plantedWith((a) => {
      a.data[101] = 4;
      return a;
    });
    await expectRejected(readAttestation(chain, deployment, WALLET), 'attestation_malformed');
  });

  it('is_a_full_size_account_of_zeros_owned_by_sas', async () => {
    const { chain, deployment } = await plantedWith(() => ({
      owner: SAS_PROGRAM_ID,
      data: new Uint8Array(SAS_ATTESTATION_LEN),
    }));
    await expectRejected(readAttestation(chain, deployment, WALLET), 'attestation_malformed');
  });
});

describe('readAttestation derives sas_signer instead of trusting the file (review round 1)', () => {
  it('rejects_a_deployment_whose_sas_signer_is_not_the_oracle_programs_pda', async () => {
    const good = await testDeployment();
    const { chain } = await walletChain(1);
    expect((await readAttestation(chain, good, WALLET)).signerOk).toBe(true);
    const bad = await testDeployment({ sasSigner: OTHER_ADDRESS });
    await expectRejected(readAttestation(chain, bad, WALLET), 'deployment_malformed');
  });

  it('judges_signer_ok_against_the_derived_pda_not_the_stored_signer_alone', async () => {
    // An attestation signed by OTHER_ADDRESS stays signerOk=false even if the file claimed that signer.
    const { chain } = await walletChain(1, { signer: OTHER_ADDRESS });
    const honest = await testDeployment();
    expect((await readAttestation(chain, honest, WALLET)).signerOk).toBe(false);
  });
});
