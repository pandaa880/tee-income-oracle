// The relayer against the real oracle + SAS programs on an embedded surfnet.
import { type Address, address, generateKeyPairSigner, signature } from '@solana/kit';
import { ORACLE_PROGRAM_ADDRESS } from '@tio/oracle-client';
import {
  MAX_SIGNATURE_LIFETIME_SECS,
  SAS_PROGRAM_ID,
  attestationAddress,
  buildMessage,
  buildPayload,
  freshClock,
  readAttestation,
  signMessage,
} from '@tio/oracle-tests/attest';
import { type Fixture, startFixture } from '@tio/oracle-tests/attest-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { kitChain } from './chain.ts';
import { createRelayer } from './relayer.ts';
import { expectRejected } from './testing/expect-rejected.ts';

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

async function newWallet(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}

describe('relayer.submit (surfpool)', { timeout: 120_000 }, () => {
  let f: Fixture;
  let relayer: ReturnType<typeof createRelayer>;

  beforeAll(async () => {
    f = await startFixture();
    relayer = createRelayer({
      chain: kitChain(f.h.rpc, f.h.rpcSubscriptions),
      payer: f.relayer,
      deployment: {
        oracleProgram: ORACLE_PROGRAM_ADDRESS,
        credential: f.credential,
        schema: f.schema,
        sasProgram: SAS_PROGRAM_ID,
        pools: [],
      },
      measurementId: f.entryId,
    });
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  type Signed = {
    payload: Uint8Array;
    signature: Uint8Array;
    expiry: bigint;
    args: { wallet: string; payloadHex: string; signatureHex: string; expiry: number };
  };

  /** What the enclave would return: a payload signed (§8) by the fixture's registered key. */
  function enclaveOutput(wallet: Address, issuedAt: bigint, tier = 1): Signed {
    const payload = buildPayload({ issuedAt, tier, measurementId: f.entryId });
    const expiry = issuedAt + MAX_SIGNATURE_LIFETIME_SECS;
    const message = buildMessage({
      programId: ORACLE_PROGRAM_ADDRESS,
      credential: f.credential,
      schema: f.schema,
      wallet,
      payload,
      expiry,
    });
    const enclaveSignature = signMessage(f.key.secretKey, message);
    return {
      payload,
      signature: enclaveSignature,
      expiry,
      args: {
        wallet,
        payloadHex: toHex(payload),
        signatureHex: toHex(enclaveSignature),
        expiry: Number(expiry),
      },
    };
  }

  it('lands the attestation and returns the tx signature and the attestation address', async () => {
    const now = await freshClock(f.h);
    const wallet = await newWallet();
    const out = enclaveOutput(wallet, now, 2);
    const result = await relayer.submit(out.args);
    const expectedAddress = await attestationAddress(f.credential, f.schema, wallet);
    expect(result.attestation).toBe(expectedAddress);
    expect(result.tx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
    const stored = await readAttestation(f.h, expectedAddress);
    expect(stored?.data).toEqual(out.payload);
    expect(stored?.expiry).toBeGreaterThan(now);
  });

  it('sends one transaction of compute-budget, precompile and submit_attestation', async () => {
    const now = await freshClock(f.h);
    const out = enclaveOutput(await newWallet(), now);
    const { tx } = await relayer.submit(out.args);
    if (tx === null) throw new Error('a fresh submit must report its own signature');
    const fetched = await f.h.rpc
      .getTransaction(signature(tx), {
        commitment: 'confirmed',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
    expect(fetched?.transaction.message.instructions).toHaveLength(3);
    expect(fetched?.meta?.err).toBeNull();
  });

  it('refreshes a wallet with a newer payload', async () => {
    const now = await freshClock(f.h);
    const wallet = await newWallet();
    await relayer.submit(enclaveOutput(wallet, now, 3).args);
    const newer = enclaveOutput(wallet, now + 5n, 1);
    const result = await relayer.submit(newer.args);
    const stored = await readAttestation(f.h, address(result.attestation));
    expect(stored?.data).toEqual(newer.payload);
  });

  it('treats a resubmitted identical payload (oracle 6026) as success with the same attestation', async () => {
    const now = await freshClock(f.h);
    const out = enclaveOutput(await newWallet(), now);
    const first = await relayer.submit(out.args);
    const second = await relayer.submit(out.args);
    expect(second.attestation).toBe(first.attestation);
    // Our own landed signature, or null when an earlier tx stored it: never a guess.
    expect([first.tx, null]).toContain(second.tx);
    const stored = await readAttestation(f.h, address(second.attestation));
    expect(stored?.data).toEqual(out.payload);
  });

  it('rejects stale_attestation (chain) when a newer attestation is already stored', async () => {
    const now = await freshClock(f.h);
    const wallet = await newWallet();
    const newer = enclaveOutput(wallet, now, 1);
    const older = enclaveOutput(wallet, now - 10n, 2);
    await relayer.submit(newer.args);
    await expectRejected(relayer.submit(older.args), { code: 'stale_attestation', stage: 'chain' });
    const stored = await readAttestation(
      f.h,
      await attestationAddress(f.credential, f.schema, wallet),
    );
    expect(stored?.data).toEqual(newer.payload);
  });

  it('rejects tx_failed (chain) for a bad signature and stores nothing', async () => {
    const now = await freshClock(f.h);
    const wallet = await newWallet();
    const out = enclaveOutput(wallet, now);
    const bad = new Uint8Array(out.signature);
    bad[10] = (bad[10] ?? 0) ^ 0xff;
    await expectRejected(relayer.submit({ ...out.args, signatureHex: toHex(bad) }), {
      code: 'tx_failed',
      stage: 'chain',
    });
    expect(
      await readAttestation(f.h, await attestationAddress(f.credential, f.schema, wallet)),
    ).toBeUndefined();
  });
});
