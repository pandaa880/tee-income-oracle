/**
 * The relay flow (shape check -> borrower signature -> relayer co-sign -> simulate -> send ->
 * confirm) against a scripted RelayChain. The clock and sleeper are injected, so the confirm
 * timeout runs without real waiting.
 */
import {
  type KeyPairSigner,
  generateKeyPairSigner,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  verifySignature,
} from '@solana/kit';
import { b64Decode, b64Encode } from '@tio/encoding';
import { beforeAll, describe, expect, it } from 'vitest';

import { GatewayError } from './errors.ts';
import {
  CONFIRM_POLL_MS,
  MAX_IN_FLIGHT,
  SEND_ERROR_GRACE_MS,
  createLoanRelay,
} from './loan-relay-flow.ts';
import { ATA_SPONSOR_BURST } from './sponsorship.ts';
import { CONFIRM_TIMEOUT_MS } from './timeouts.ts';
import { expectRejected } from './testing/expect-rejected.ts';
import {
  CONFIRMED,
  SENT_SIGNATURE,
  type RelayScript,
  fakeRelayChain,
} from './testing/fake-relay.ts';
import {
  POOL,
  type LoanOpts,
  borrowParts,
  buildBorrowTx,
  buildRepayTx,
  buildTx,
  testDeployment,
} from './testing/loan-tx.ts';

let relayer: KeyPairSigner;
let borrower: KeyPairSigner;
let opts: LoanOpts;
const deployment = testDeployment();

beforeAll(async () => {
  [relayer, borrower] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  opts = { relayer: relayer.address, borrower, deployment, pool: POOL };
});

function setup(script: RelayScript = {}) {
  const chain = fakeRelayChain(script);
  const clock = { t: 1_000_000, sleeps: [] as number[] };
  const relay = createLoanRelay({
    chain,
    payer: relayer,
    deployment,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  });
  return { chain, clock, relay };
}

const b64 = (wire: Uint8Array): string => b64Encode(wire);
const noWork = (chain: ReturnType<typeof fakeRelayChain>) =>
  expect({ simulate: chain.calls.simulate.length, send: chain.calls.send.length }).toEqual({
    simulate: 0,
    send: 0,
  });

async function borrowTxB64(who: KeyPairSigner = borrower): Promise<string> {
  return b64((await buildBorrowTx({ ...opts, borrower: who })).wire);
}

describe('relay: refuses before any chain call', () => {
  it('rejects a bad shape with bad_transaction 400 and detail { rule }', async () => {
    const s = setup();
    const { ata, borrow } = await borrowParts(opts);
    const legacy = await buildTx({
      feePayer: relayer.address,
      instructions: [ata, borrow],
      signers: [borrower],
      version: 'legacy',
    });
    const e = await expectRejected(s.relay.relay({ tx_b64: b64(legacy.wire) }), {
      code: 'bad_transaction',
      stage: 'gateway',
      status: 400,
    });
    expect(e.detail).toEqual({ rule: 1 });
    noWork(s.chain);
  });

  it('rejects a body that is not decodable as a transaction as rule 1', async () => {
    const s = setup();
    const e = await expectRejected(s.relay.relay({ tx_b64: '!!not base64!!' }), {
      code: 'bad_transaction',
      stage: 'gateway',
      status: 400,
    });
    expect(e.detail).toEqual({ rule: 1 });
    noWork(s.chain);
  });

  it('rejects an already relayer-signed transaction as rule 4', async () => {
    const s = setup();
    const { ata, borrow } = await borrowParts(opts);
    const signed = await buildTx({
      feePayer: relayer.address,
      instructions: [ata, borrow],
      signers: [relayer, borrower],
    });
    const e = await expectRejected(s.relay.relay({ tx_b64: b64(signed.wire) }), {
      code: 'bad_transaction',
      stage: 'gateway',
      status: 400,
    });
    expect(e.detail).toEqual({ rule: 4 });
    noWork(s.chain);
  });

  it('rejects a forged borrower signature as rule 11 (a shape-valid tx)', async () => {
    const s = setup();
    const { ata, borrow } = await borrowParts(opts);
    const forged = await buildTx({
      feePayer: relayer.address,
      instructions: [ata, borrow],
      signers: [borrower],
      forged: [borrower.address],
    });
    const e = await expectRejected(s.relay.relay({ tx_b64: b64(forged.wire) }), {
      code: 'bad_transaction',
      stage: 'gateway',
      status: 400,
    });
    expect(e.detail).toEqual({ rule: 11 });
    noWork(s.chain);
  });

  it('rejects a signature made by a different key than the borrower account as rule 11', async () => {
    const s = setup();
    const impostor = await generateKeyPairSigner();
    const { ata, borrow } = await borrowParts(opts);
    // The impostor signs the borrower slot's message: same bytes, wrong key.
    const real = await buildTx({
      feePayer: relayer.address,
      instructions: [ata, borrow],
      signers: [borrower],
    });
    const swapped = await buildTx({
      feePayer: relayer.address,
      instructions: [ata, borrow],
      signers: [{ ...impostor, address: borrower.address }],
    });
    expect(swapped.wire).not.toEqual(real.wire);
    const e = await expectRejected(s.relay.relay({ tx_b64: b64(swapped.wire) }), {
      code: 'bad_transaction',
      stage: 'gateway',
      status: 400,
    });
    expect(e.detail).toEqual({ rule: 11 });
    noWork(s.chain);
  });

  it('never echoes the transaction in the error message', async () => {
    const s = setup();
    const tx_b64 = b64(new Uint8Array(40).fill(7));
    const e = await expectRejected(s.relay.relay({ tx_b64 }), {
      code: 'bad_transaction',
      stage: 'gateway',
      status: 400,
    });
    expect(e.message).not.toContain(tx_b64);
  });
});

describe('relay: simulation', () => {
  it('maps a program error to simulation_failed 409 with detail { index, custom } and sends nothing', async () => {
    const s = setup({ simulateErr: { InstructionError: [1, { Custom: 6008 }] } });
    const e = await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
      code: 'simulation_failed',
      stage: 'chain',
      status: 409,
    });
    expect(e.detail).toEqual({ index: 1, custom: 6008 });
    expect(s.chain.calls.simulate).toHaveLength(1);
    expect(s.chain.calls.send).toEqual([]);
  });

  it.each([
    [
      'a named instruction error',
      { InstructionError: [0, 'InvalidAccountData'] },
      { index: 0, kind: 'InvalidAccountData' },
    ],
    ['a transaction error', 'BlockhashNotFound', { kind: 'BlockhashNotFound' }],
    ['an unrecognised shape', { foo: 1 }, { kind: 'unknown' }],
  ])('maps %s to its detail and sends nothing', async (_name, err, detail) => {
    const s = setup({ simulateErr: err });
    const e = await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
      code: 'simulation_failed',
      stage: 'chain',
      status: 409,
    });
    expect(e.detail).toEqual(detail);
    expect(s.chain.calls.send).toEqual([]);
  });
});

describe('relay: simulation cannot run', () => {
  it('answers tx_failed 502 when the simulation RPC fails, and sends nothing', async () => {
    const s = setup({ simulateError: new Error('rpc down: secret host') });
    const e = await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
      code: 'tx_failed',
      stage: 'chain',
      status: 502,
    });
    expect(e.message).not.toContain('secret host');
    expect(s.chain.calls.send).toEqual([]);
  });
});

describe('relay: send and confirm', () => {
  it('returns the signature once the status is confirmed', async () => {
    const s = setup();
    await expect(s.relay.relay({ tx_b64: await borrowTxB64() })).resolves.toEqual({
      signature: SENT_SIGNATURE,
    });
    expect(s.chain.calls.simulate).toHaveLength(1);
    expect(s.chain.calls.send).toHaveLength(1);
  });

  it('relays a repay too', async () => {
    const s = setup();
    const repay = await buildRepayTx(opts);
    await expect(s.relay.relay({ tx_b64: b64(repay.wire) })).resolves.toEqual({
      signature: SENT_SIGNATURE,
    });
  });

  it('polls every CONFIRM_POLL_MS until the status shows up', async () => {
    const s = setup({ statuses: [null, null, CONFIRMED] });
    await s.relay.relay({ tx_b64: await borrowTxB64() });
    expect(CONFIRM_POLL_MS).toBe(1_000);
    expect(s.chain.calls.statuses).toBe(3);
    expect(s.clock.sleeps).toEqual([CONFIRM_POLL_MS, CONFIRM_POLL_MS]);
  });

  it('keeps polling through processed and resolves on finalized', async () => {
    const s = setup({
      statuses: [
        { err: null, confirmationStatus: 'processed' },
        { err: null, confirmationStatus: 'finalized' },
      ],
    });
    await expect(s.relay.relay({ tx_b64: await borrowTxB64() })).resolves.toEqual({
      signature: SENT_SIGNATURE,
    });
    expect(s.chain.calls.statuses).toBe(2);
  });

  it('keeps polling when a status poll fails, and resolves once one succeeds', async () => {
    const s = setup({ statuses: [new Error('rpc hiccup'), CONFIRMED] });
    await expect(s.relay.relay({ tx_b64: await borrowTxB64() })).resolves.toEqual({
      signature: SENT_SIGNATURE,
    });
    expect(s.chain.calls.statuses).toBe(2);
  });

  it('answers tx_failed 502 when the cluster reports an error for the signature', async () => {
    const s = setup({
      statuses: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }],
    });
    await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
      code: 'tx_failed',
      stage: 'chain',
      status: 502,
    });
  });

  it('answers tx_failed 502 when send is rejected and no status shows up within the grace period', async () => {
    const s = setup({ sendError: new Error('node says no'), statuses: [null] });
    const start = s.clock.t;
    const e = await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
      code: 'tx_failed',
      stage: 'chain',
      status: 502,
    });
    expect(e.message).not.toContain('node says no');
    const waited = s.clock.t - start;
    expect(waited).toBeGreaterThanOrEqual(SEND_ERROR_GRACE_MS);
    expect(waited).toBeLessThan(CONFIRM_TIMEOUT_MS);
    expect(s.chain.calls.statuses).toBeGreaterThan(1);
  });

  it('treats a lost send reply as sent: a confirmed status for the derived signature is success', async () => {
    const s = setup({ sendError: new Error('socket hang up'), statuses: [CONFIRMED] });
    const { signature } = await s.relay.relay({ tx_b64: await borrowTxB64() });
    const sent = s.chain.calls.simulate[0] ?? '';
    const derived = getSignatureFromTransaction(getTransactionDecoder().decode(b64Decode(sent)));
    expect(signature).toBe(derived);
    expect(signature).not.toBe(SENT_SIGNATURE);
    expect(s.chain.calls.statuses).toBe(1);
  });

  it('answers tx_failed 502 when a lost send reply is followed by a status error', async () => {
    const s = setup({
      sendError: new Error('socket hang up'),
      statuses: [
        { err: { InstructionError: [1, { Custom: 6007 }] }, confirmationStatus: 'confirmed' },
      ],
    });
    await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
      code: 'tx_failed',
      stage: 'chain',
      status: 502,
    });
  });

  it('answers tx_failed 502 when the signature is never confirmed within CONFIRM_TIMEOUT_MS', async () => {
    const s = setup({ statuses: [null] });
    const start = s.clock.t;
    await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
      code: 'tx_failed',
      stage: 'chain',
      status: 502,
    });
    const waited = s.clock.t - start;
    expect(waited).toBeGreaterThanOrEqual(CONFIRM_TIMEOUT_MS);
    expect(waited).toBeLessThanOrEqual(CONFIRM_TIMEOUT_MS + CONFIRM_POLL_MS);
  });

  it('answers tx_failed 502 when every status poll fails until CONFIRM_TIMEOUT_MS', async () => {
    const s = setup({ statuses: [new Error('down')] });
    const start = s.clock.t;
    await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
      code: 'tx_failed',
      stage: 'chain',
      status: 502,
    });
    expect(s.clock.t - start).toBeGreaterThanOrEqual(CONFIRM_TIMEOUT_MS);
  });

  it('does not time out before CONFIRM_TIMEOUT_MS', async () => {
    const polls = Math.floor(CONFIRM_TIMEOUT_MS / CONFIRM_POLL_MS) - 2;
    const s = setup({ statuses: [...Array<null>(polls).fill(null), CONFIRMED] });
    await expect(s.relay.relay({ tx_b64: await borrowTxB64() })).resolves.toEqual({
      signature: SENT_SIGNATURE,
    });
  });
});

describe('relay: the sent transaction', () => {
  it('carries the relayer signature and the original borrower signature over unchanged bytes', async () => {
    const s = setup();
    const original = await buildBorrowTx(opts);
    await s.relay.relay({ tx_b64: b64(original.wire) });

    const sent = s.chain.calls.send[0];
    expect(sent).toBeDefined();
    expect(s.chain.calls.simulate).toEqual(s.chain.calls.send);
    const tx = getTransactionDecoder().decode(b64Decode(sent ?? ''));
    expect(tx.messageBytes).toEqual(original.tx.messageBytes);

    const relayerSig = tx.signatures[relayer.address];
    expect(relayerSig?.length).toBe(64);
    expect(tx.signatures[borrower.address]).toEqual(original.tx.signatures[borrower.address]);
    if (relayerSig === undefined || relayerSig === null) throw new Error('relayer did not sign');
    const ok = await verifySignature(
      await getPublicKeyFromAddress(relayer.address),
      relayerSig,
      tx.messageBytes,
    );
    expect(ok).toBe(true);
  });
});

function gated() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

/** `account` answer for a token account the relayer would have to pay for. */
const missing = (): null => null;

describe('relay: the token-account rent is budgeted', () => {
  it("funds a wallet's token account once: borrowing again with it missing is sponsorship_exhausted 429", async () => {
    const s = setup({ account: missing });
    await expect(s.relay.relay({ tx_b64: await borrowTxB64() })).resolves.toEqual({
      signature: SENT_SIGNATURE,
    });
    await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
      code: 'sponsorship_exhausted',
      stage: 'gateway',
      status: 429,
    });
    // Refused before any signing or simulation.
    expect(s.chain.calls.simulate).toHaveLength(1);
    expect(s.chain.calls.send).toHaveLength(1);
  });

  it('leaves the budget alone when the token account already exists', async () => {
    const s = setup();
    for (let i = 0; i < 3; i += 1) {
      await expect(s.relay.relay({ tx_b64: await borrowTxB64() })).resolves.toEqual({
        signature: SENT_SIGNATURE,
      });
    }
    expect(s.chain.calls.accounts).toHaveLength(3);
  });

  it('never consults the budget for a repay', async () => {
    const s = setup({ account: missing });
    const repay = b64((await buildRepayTx(opts)).wire);
    await expect(s.relay.relay({ tx_b64: repay })).resolves.toEqual({ signature: SENT_SIGNATURE });
    expect(s.chain.calls.accounts).toEqual([]);
  });

  it("does not spend the wallet's sponsorship on a failed simulation", async () => {
    const script: RelayScript = {
      account: missing,
      simulateErr: { InstructionError: [1, { Custom: 6008 }] },
    };
    const s = setup(script);
    await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
      code: 'simulation_failed',
      stage: 'chain',
      status: 409,
    });
    delete script.simulateErr;
    await expect(s.relay.relay({ tx_b64: await borrowTxB64() })).resolves.toEqual({
      signature: SENT_SIGNATURE,
    });
  });

  it('caps sponsored accounts at ATA_SPONSOR_BURST across wallets, then refills one per three minutes', async () => {
    expect(ATA_SPONSOR_BURST).toBe(20);
    const s = setup({ account: missing });
    const wallets = await Promise.all(
      Array.from({ length: ATA_SPONSOR_BURST + 1 }, () => generateKeyPairSigner()),
    );
    for (const w of wallets.slice(0, ATA_SPONSOR_BURST)) {
      await expect(s.relay.relay({ tx_b64: await borrowTxB64(w) })).resolves.toEqual({
        signature: SENT_SIGNATURE,
      });
    }
    const extra = wallets[ATA_SPONSOR_BURST];
    if (extra === undefined) throw new Error('unreachable');
    await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64(extra) }), {
      code: 'sponsorship_exhausted',
      stage: 'gateway',
      status: 429,
    });
    s.clock.t += 3 * 60_000; // 20 per hour = one token every 3 minutes
    await expect(s.relay.relay({ tx_b64: await borrowTxB64(extra) })).resolves.toEqual({
      signature: SENT_SIGNATURE,
    });
  });
});

describe('relay: one in flight per borrower', () => {
  it('refuses a second relay for the same borrower while the first is in flight, then frees the borrower', async () => {
    const { gate, open } = gated();
    const s = setup({ gate });
    const first = s.relay.relay({ tx_b64: await borrowTxB64() });
    try {
      await s.chain.simulations(1);
      const repay = b64((await buildRepayTx(opts)).wire);
      await expectRejected(s.relay.relay({ tx_b64: repay }), {
        code: 'relay_in_flight',
        stage: 'gateway',
        status: 429,
      });
      // The refused attempt must not have released the first one's lock.
      await expectRejected(s.relay.relay({ tx_b64: repay }), {
        code: 'relay_in_flight',
        stage: 'gateway',
        status: 429,
      });
      expect(s.chain.calls.simulate).toHaveLength(1);
    } finally {
      open();
    }
    await expect(first).resolves.toEqual({ signature: SENT_SIGNATURE });
    await expect(s.relay.relay({ tx_b64: await borrowTxB64() })).resolves.toEqual({
      signature: SENT_SIGNATURE,
    });
  });

  it('lets two different borrowers relay at the same time', async () => {
    const { gate, open } = gated();
    const s = setup({ gate });
    const other = await generateKeyPairSigner();
    const a = s.relay.relay({ tx_b64: await borrowTxB64() });
    const b = s.relay.relay({ tx_b64: await borrowTxB64(other) });
    try {
      await s.chain.simulations(2);
    } finally {
      open();
    }
    await expect(Promise.all([a, b])).resolves.toEqual([
      { signature: SENT_SIGNATURE },
      { signature: SENT_SIGNATURE },
    ]);
  });

  it('frees the borrower after a failed simulation', async () => {
    const s = setup({ simulateErr: { InstructionError: [1, { Custom: 6008 }] } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
        code: 'simulation_failed',
        stage: 'chain',
        status: 409,
      });
    }
  });

  it('frees the borrower after a send failure', async () => {
    const s = setup({ sendError: new Error('down'), statuses: [null] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
        code: 'tx_failed',
        stage: 'chain',
        status: 502,
      });
    }
  });

  it('frees the borrower after a confirm timeout', async () => {
    const s = setup({ statuses: [null] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectRejected(s.relay.relay({ tx_b64: await borrowTxB64() }), {
        code: 'tx_failed',
        stage: 'chain',
        status: 502,
      });
    }
  });

  it('refuses relay number MAX_IN_FLIGHT + 1 with relay_in_flight, and accepts it again once one finishes', async () => {
    expect(MAX_IN_FLIGHT).toBe(64);
    const { gate, open } = gated();
    const s = setup({ gate });
    const borrowers = await Promise.all(
      Array.from({ length: MAX_IN_FLIGHT + 1 }, () => generateKeyPairSigner()),
    );
    const txs = await Promise.all(borrowers.map((b) => borrowTxB64(b)));
    const held = txs.slice(0, MAX_IN_FLIGHT).map((tx_b64) => s.relay.relay({ tx_b64 }));
    const extra = txs[MAX_IN_FLIGHT] ?? '';
    try {
      await s.chain.simulations(MAX_IN_FLIGHT);
      const e = await expectRejected(s.relay.relay({ tx_b64: extra }), {
        code: 'relay_in_flight',
        stage: 'gateway',
        status: 429,
      });
      expect(e).toBeInstanceOf(GatewayError);
      expect(s.chain.calls.simulate).toHaveLength(MAX_IN_FLIGHT);
    } finally {
      open();
    }
    await Promise.all(held);
    await expect(s.relay.relay({ tx_b64: extra })).resolves.toEqual({ signature: SENT_SIGNATURE });
  });
});
