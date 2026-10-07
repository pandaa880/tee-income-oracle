// The relayer's after-error branches over a fake Chain (the surfpool suite covers the real path):
// own-signature checks, `tx: null` for an already-stored payload, the one blockhash rebuild,
// 6026, and chain failures before sending.
import {
  type Address,
  type Blockhash,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  type Signature,
  SolanaError,
  address,
  generateKeyPairSigner,
  getSignatureFromTransaction,
} from '@solana/kit';
import { getEnclaveEntryEncoder } from '@tio/oracle-client';
import {
  ORACLE_PROGRAM_ID,
  SAS_ATTESTATION_DISCRIMINATOR,
  SAS_ATTESTATION_LEN,
  SAS_DATA_LEN_OFFSET,
  SAS_DATA_OFFSET,
  SAS_PROGRAM_ID,
  attestationAddress,
  enclaveEntryAddress,
} from '@tio/oracle-client/attest';
import { describe, expect, it } from 'vitest';

import type { Chain, RawAccount, SignatureStatus, SignedTransaction } from './chain.ts';
import { createRelayer } from './relayer.ts';
import { expectRejected } from './testing/expect-rejected.ts';

const CREDENTIAL = address('F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7');
const SCHEMA = address('991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV');
const WALLET = address('3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND');
const MEASUREMENT_ID = 3;
const PAYLOAD = new Uint8Array(83).fill(0x11);
const OTHER_PAYLOAD = new Uint8Array(83).fill(0x22);
const BLOCKHASHES: Blockhash[] = [
  'So11111111111111111111111111111111111111112',
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
].map((b) => b as Blockhash);
const ARGS = {
  wallet: WALLET,
  payloadHex: Buffer.from(PAYLOAD).toString('hex'),
  signatureHex: 'cd'.repeat(65),
  expiry: 1_790_000_600,
};

const blockHeightExceeded = () =>
  new SolanaError(SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED, {
    currentBlockHeight: 200n,
    lastValidBlockHeight: 150n,
  });
const custom = (code: number) =>
  new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, { code, index: 2 });
const confirmed: SignatureStatus = { err: null, confirmationStatus: 'confirmed' };

function sasAccount(payload: Uint8Array): RawAccount {
  const data = new Uint8Array(SAS_ATTESTATION_LEN);
  data[0] = SAS_ATTESTATION_DISCRIMINATOR;
  new DataView(data.buffer).setUint32(SAS_DATA_LEN_OFFSET, 83, true);
  data.set(payload, SAS_DATA_OFFSET);
  return { owner: SAS_PROGRAM_ID, data };
}

function entryAccount(revokedAt = 0n): RawAccount {
  const data = getEnclaveEntryEncoder().encode({
    version: 1,
    bump: 255,
    measurementId: MEASUREMENT_ID,
    measurementKind: 1,
    measurement: new Uint8Array(32),
    attester: new Uint8Array(20).fill(0xbb),
    attestationDocHash: new Uint8Array(32),
    registeredAt: 1n,
    revokedAt,
  });
  return { owner: ORACLE_PROGRAM_ID, data: new Uint8Array(data) };
}

type FakeOpts = {
  /** Outcome of each send in order: undefined = confirmed, an Error = rejected. */
  sends: (Error | undefined)[];
  /** Status per signature, by send index. */
  status?: (index: number) => SignatureStatus | null;
  stored?: Uint8Array | null;
  entry?: RawAccount | null;
  blockhashFails?: boolean;
  entryFails?: boolean;
  statusesFail?: boolean;
};

async function setup(o: FakeOpts) {
  const sent: Signature[] = [];
  const attestation = await attestationAddress(CREDENTIAL, SCHEMA, WALLET);
  const entryAt = await enclaveEntryAddress(MEASUREMENT_ID);
  let blockhashes = 0;
  const reads = { entry: 0 };
  const chain: Chain = {
    latestBlockhash: async () => {
      if (o.blockhashFails === true) throw new Error('rpc timeout');
      const blockhash = BLOCKHASHES[blockhashes % BLOCKHASHES.length] ?? BLOCKHASHES[0];
      blockhashes += 1;
      if (blockhash === undefined) throw new Error('no blockhash');
      return { blockhash, lastValidBlockHeight: 150n };
    },
    sendAndConfirm: async (tx: SignedTransaction) => {
      const outcome = o.sends[sent.length];
      sent.push(getSignatureFromTransaction(tx));
      if (outcome !== undefined) throw outcome;
    },
    signatureStatuses: async (sigs) => {
      if (o.statusesFail === true) throw new Error('rpc timeout');
      return sigs.map((s) => o.status?.(sent.indexOf(s)) ?? null);
    },
    account: async (at: Address) => {
      if (at === entryAt) {
        reads.entry += 1;
        if (o.entryFails === true) throw new Error('rpc timeout');
        return o.entry === undefined ? entryAccount() : o.entry;
      }
      if (at === attestation) return o.stored == null ? null : sasAccount(o.stored);
      return null;
    },
  };
  const relayer = createRelayer({
    chain,
    payer: await generateKeyPairSigner(),
    deployment: {
      oracleProgram: ORACLE_PROGRAM_ID,
      credential: CREDENTIAL,
      schema: SCHEMA,
      sasProgram: SAS_PROGRAM_ID,
    },
    measurementId: MEASUREMENT_ID,
  });
  const entryReads = () => reads.entry;
  return { relayer, sent, attestation, entryReads };
}

describe('relayer: success', () => {
  it('returns its own signature and the attestation address when the send confirms', async () => {
    const t = await setup({ sends: [undefined] });
    const result = await t.relayer.submit(ARGS);
    expect(t.sent).toHaveLength(1);
    expect(result).toEqual({ tx: t.sent[0], attestation: t.attestation });
  });
});

describe('relayer: after a failed send', () => {
  it('returns its own signature when that signature landed after all (e.g. websocket dropped)', async () => {
    const t = await setup({ sends: [new Error('ws closed')], status: () => confirmed });
    expect(await t.relayer.submit(ARGS)).toEqual({ tx: t.sent[0], attestation: t.attestation });
  });

  it('does not count a signature seen only at processed', async () => {
    const t = await setup({
      sends: [new Error('timeout')],
      status: () => ({ err: null, confirmationStatus: 'processed' }),
    });
    await expectRejected(t.relayer.submit(ARGS), { code: 'tx_failed', stage: 'chain' });
  });

  it('does not count a signature whose confirmation status is unknown (null)', async () => {
    const t = await setup({
      sends: [new Error('timeout')],
      status: () => ({ err: null, confirmationStatus: null }),
    });
    await expectRejected(t.relayer.submit(ARGS), { code: 'tx_failed', stage: 'chain' });
  });

  it('counts a finalized signature', async () => {
    const t = await setup({
      sends: [new Error('ws closed')],
      status: () => ({ err: null, confirmationStatus: 'finalized' }),
    });
    expect(await t.relayer.submit(ARGS)).toEqual({ tx: t.sent[0], attestation: t.attestation });
  });

  it('does not count a signature that landed with an error', async () => {
    const t = await setup({
      sends: [new Error('timeout')],
      status: () => ({
        err: { InstructionError: [2, { Custom: 1 }] },
        confirmationStatus: 'confirmed',
      }),
    });
    await expectRejected(t.relayer.submit(ARGS), {
      code: 'tx_failed',
      stage: 'chain',
      status: 502,
    });
  });

  it('reports tx null when the payload is already stored but none of its signatures landed', async () => {
    const t = await setup({ sends: [new Error('AlreadyProcessed')], stored: PAYLOAD });
    expect(await t.relayer.submit(ARGS)).toEqual({ tx: null, attestation: t.attestation });
  });

  it('still checks the stored payload when the status lookup fails', async () => {
    const t = await setup({ sends: [new Error('timeout')], statusesFail: true, stored: PAYLOAD });
    expect(await t.relayer.submit(ARGS)).toEqual({ tx: null, attestation: t.attestation });
  });
});

describe('relayer: 6026 (StaleAttestation)', () => {
  it('rejects stale_attestation 409 when a different payload is stored', async () => {
    const t = await setup({ sends: [custom(6026)], stored: OTHER_PAYLOAD });
    await expectRejected(t.relayer.submit(ARGS), {
      code: 'stale_attestation',
      stage: 'chain',
      status: 409,
    });
    expect(t.sent).toHaveLength(1);
  });

  it('succeeds with tx null when exactly this payload is stored', async () => {
    const t = await setup({ sends: [custom(6026)], stored: PAYLOAD });
    expect(await t.relayer.submit(ARGS)).toEqual({ tx: null, attestation: t.attestation });
  });

  it('maps any other program error to tx_failed without a retry', async () => {
    const t = await setup({ sends: [custom(6020)] });
    await expectRejected(t.relayer.submit(ARGS), { code: 'tx_failed', stage: 'chain' });
    expect(t.sent).toHaveLength(1);
  });
});

describe('relayer: expired blockhash', () => {
  it('re-signs once with a fresh blockhash and returns the new signature', async () => {
    const t = await setup({ sends: [blockHeightExceeded(), undefined] });
    const result = await t.relayer.submit(ARGS);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]).not.toBe(t.sent[0]);
    expect(result).toEqual({ tx: t.sent[1], attestation: t.attestation });
  });

  it('gives up with tx_failed after the second expiry (no third send)', async () => {
    const t = await setup({ sends: [blockHeightExceeded(), blockHeightExceeded()] });
    await expectRejected(t.relayer.submit(ARGS), { code: 'tx_failed', stage: 'chain' });
    expect(t.sent).toHaveLength(2);
  });

  it('returns the FIRST signature if it landed late while the retry failed', async () => {
    const t = await setup({
      sends: [blockHeightExceeded(), new Error('timeout')],
      status: (index) => (index === 0 ? confirmed : null),
    });
    expect(await t.relayer.submit(ARGS)).toEqual({ tx: t.sent[0], attestation: t.attestation });
  });
});

describe('relayer: chain failures before sending', () => {
  it('maps a blockhash read failure to tx_failed (chain), not internal_error', async () => {
    const t = await setup({ sends: [], blockhashFails: true });
    await expectRejected(t.relayer.submit(ARGS), { code: 'tx_failed', stage: 'chain' });
    expect(t.sent).toEqual([]);
  });

  it('maps a registry read failure to tx_failed (chain), not internal_error', async () => {
    const t = await setup({ sends: [], entryFails: true });
    await expectRejected(t.relayer.submit(ARGS), { code: 'tx_failed', stage: 'chain' });
    expect(t.sent).toEqual([]);
  });

  it('rejects enclave_revoked before sending when the registry entry is revoked', async () => {
    const t = await setup({ sends: [undefined], entry: entryAccount(1_790_000_000n) });
    await expectRejected(t.relayer.submit(ARGS), {
      code: 'enclave_revoked',
      stage: 'chain',
      status: 503,
    });
    expect(t.sent).toEqual([]);
  });

  it('re-reads the registry entry on every submit, so a later revoke is seen', async () => {
    const opts: FakeOpts = { sends: [undefined, undefined] };
    const t = await setup(opts);
    await t.relayer.submit(ARGS);
    opts.entry = entryAccount(1_790_000_000n);
    await expectRejected(t.relayer.submit(ARGS), { code: 'enclave_revoked', stage: 'chain' });
    expect(t.entryReads()).toBe(2);
    expect(t.sent).toHaveLength(1);
  });

  it('rejects enclave_not_registered when the registry entry is missing', async () => {
    const t = await setup({ sends: [], entry: null });
    await expectRejected(t.relayer.submit(ARGS), {
      code: 'enclave_not_registered',
      stage: 'chain',
      status: 503,
    });
  });
});

describe('createRelayer', () => {
  it('refuses a deployment whose oracle program id differs from the compiled-in one', async () => {
    const chain: Chain = {
      latestBlockhash: async () => ({ blockhash: 'x' as Blockhash, lastValidBlockHeight: 0n }),
      sendAndConfirm: async () => {},
      signatureStatuses: async () => [],
      account: async () => null,
    };
    const create = async () =>
      createRelayer({
        chain,
        payer: await generateKeyPairSigner(),
        deployment: {
          oracleProgram: 'So11111111111111111111111111111111111111112',
          credential: CREDENTIAL,
          schema: SCHEMA,
          sasProgram: SAS_PROGRAM_ID,
        },
        measurementId: 0,
      });
    await expect(create()).rejects.toThrow(/program ids differ/);
  });
});
