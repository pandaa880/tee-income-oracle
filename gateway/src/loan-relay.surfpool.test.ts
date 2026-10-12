/**
 * Sponsored borrow and repay through the real relay on an embedded surfnet: real oracle, SAS and
 * demo-pool programs, a real attestation, kitChain as the RelayChain.
 */
import {
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
  generateKeyPairSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { findLoanPda } from '@tio/demo-pool-client';
import { b64Encode } from '@tio/encoding';
import { send } from '@tio/oracle-tests/harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type PoolFixture,
  type PoolRef,
  attest,
  fundedPool,
  fundedSigner,
  lamportsOf,
  poolParams,
  startPoolFixture,
  updatePoolInstruction,
} from '../../programs/demo-pool/tests/src/pool-fixture.ts';
import { tokenBalance } from '../../programs/demo-pool/tests/src/token.ts';
import { type RelayChain, kitChain } from './chain.ts';
import { createLoanRelay } from './loan-relay-flow.ts';
import { expectRejected } from './testing/expect-rejected.ts';
import {
  type Lifetime,
  type LoanOpts,
  SYSTEM_PROGRAM,
  buildBorrowTx,
  buildRepayTx,
  buildTx,
  borrowParts,
} from './testing/loan-tx.ts';

const AMOUNT = 1_000_000n;
const FEE_PER_SIGNATURE = 5_000n;
const POLICY_MISMATCH = 6008;

describe('loan relay (surfpool)', { timeout: 120_000 }, () => {
  let f: PoolFixture;
  let relayer: KeyPairSigner;
  let chain: RelayChain;
  let sends: string[];

  beforeAll(async () => {
    f = await startPoolFixture();
    relayer = await fundedSigner(f, 10);
    const real = kitChain(f.h.rpc, f.h.rpcSubscriptions);
    sends = [];
    chain = {
      ...real,
      send: (wire) => {
        sends.push(wire);
        return real.send(wire);
      },
    };
  });

  afterAll(() => {
    f.h.surfnet.stop();
  });

  const relayFor = (pool: PoolRef) =>
    createLoanRelay({
      chain,
      payer: relayer,
      deployment: {
        mint: f.mint,
        pools: [pool.address],
        credential: f.credential,
        schema: f.schema,
      },
    });

  async function loanOpts(
    pool: PoolRef,
    borrower: KeyPairSigner,
  ): Promise<LoanOpts & { lifetime: Lifetime }> {
    const { value: lifetime } = await f.h.rpc.getLatestBlockhash().send();
    return {
      relayer: relayer.address,
      borrower,
      deployment: {
        mint: f.mint,
        pools: [pool.address],
        credential: f.credential,
        schema: f.schema,
      },
      pool: pool.address,
      amount: AMOUNT,
      measurementId: f.entryId,
      lifetime,
    };
  }

  /** A wallet with 0 SOL (like the demo wallet), a real attestation and NO token account. */
  async function attestedWallet(): Promise<KeyPairSigner> {
    const wallet = await generateKeyPairSigner();
    await attest(f, wallet.address);
    return wallet;
  }

  const ataOf = async (owner: Address): Promise<Address> =>
    (await findAssociatedTokenPda({ owner, mint: f.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

  it('sponsors a borrow then a repay: the borrower pays nothing, the relayer pays fees and the ATA rent only', async () => {
    const pool = await fundedPool(f);
    const relay = relayFor(pool);
    const wallet = await attestedWallet();
    const ata = await ataOf(wallet.address);
    const relayerStart = await lamportsOf(f, relayer.address);
    const borrowerStart = await lamportsOf(f, wallet.address);

    const borrowTx = await buildBorrowTx(await loanOpts(pool, wallet));
    const { signature } = await relay.relay({ tx_b64: b64Encode(borrowTx.wire) });
    expect(signature.length).toBeGreaterThan(40);
    expect(await tokenBalance(f.h, ata)).toBe(AMOUNT);
    const afterBorrow = await lamportsOf(f, relayer.address);
    const ataRent = await lamportsOf(f, ata);
    // Fees (relayer + borrower signatures) + ATA rent + the Loan account's rent, still held.
    expect(relayerStart - afterBorrow).toBeGreaterThan(ataRent + 2n * FEE_PER_SIGNATURE);

    const repayTx = await buildRepayTx(await loanOpts(pool, wallet));
    await relay.relay({ tx_b64: b64Encode(repayTx.wire) });
    expect(await tokenBalance(f.h, ata)).toBe(0n);

    // The Loan rent came back to the relayer (it was the rent payer); only fees + ATA rent are gone.
    const relayerEnd = await lamportsOf(f, relayer.address);
    expect(relayerStart - relayerEnd).toBe(ataRent + 4n * FEE_PER_SIGNATURE);
    expect(await lamportsOf(f, wallet.address)).toBe(borrowerStart);
    const [loan] = await findLoanPda({ pool: pool.address, borrower: wallet.address });
    expect((await f.h.rpc.getAccountInfo(loan, { encoding: 'base64' }).send()).value).toBeNull();

    // The attack CodeRabbit described: close the token account (rent to the borrower), then
    // borrow again so the relayer would pay the rent once more. A fresh relay instance stands
    // for a restarted gateway with no memory of this wallet; chain history still refuses it.
    const closer = await fundedSigner(f, 1); // pays the close fee; the 0-SOL wallet only signs
    await send(f.h, closer, [
      getCloseAccountInstruction({ account: ata, destination: wallet.address, owner: wallet }),
    ]);
    expect((await f.h.rpc.getAccountInfo(ata, { encoding: 'base64' }).send()).value).toBeNull();
    const restarted = relayFor(pool);
    const sendsBefore = sends.length;
    const again = await buildBorrowTx(await loanOpts(pool, wallet));
    await expectRejected(restarted.relay({ tx_b64: b64Encode(again.wire) }), {
      code: 'sponsorship_exhausted',
      stage: 'gateway',
      status: 429,
    });
    expect(sends.length).toBe(sendsBefore);
    expect(await lamportsOf(f, relayer.address)).toBe(relayerEnd);
  });

  it('refuses a borrow after the lender changed its policy: simulation_failed with custom 6008, nothing sent', async () => {
    const pool = await fundedPool(f);
    const relay = relayFor(pool);
    const before = await attestedWallet();

    // Baseline: under the original policy the same shape goes through.
    await expect(
      relay.relay({
        tx_b64: b64Encode((await buildBorrowTx(await loanOpts(pool, before))).wire),
      }),
    ).resolves.toHaveProperty('signature');

    const stale = await attestedWallet();

    await send(f.h, pool.admin, [
      updatePoolInstruction(pool, poolParams(f, { policyHash: new Uint8Array(32).fill(0x22) })),
    ]);

    const sendsBefore = sends.length;
    const relayerBefore = await lamportsOf(f, relayer.address);
    const wire = (await buildBorrowTx(await loanOpts(pool, stale))).wire;
    const e = await expectRejected(relay.relay({ tx_b64: b64Encode(wire) }), {
      code: 'simulation_failed',
      stage: 'chain',
      status: 409,
    });
    // Instruction 0 creates the ATA; instruction 1 is the borrow that fails.
    expect(e.detail).toEqual({ index: 1, custom: POLICY_MISMATCH });
    expect(sends.length).toBe(sendsBefore);
    expect(await lamportsOf(f, relayer.address)).toBe(relayerBefore);
  });

  it('refuses a forged borrower signature before simulating or sending (rule 11)', async () => {
    const pool = await fundedPool(f);
    const relay = relayFor(pool);
    const wallet = await attestedWallet();
    const opts = await loanOpts(pool, wallet);
    const { ata, borrow } = await borrowParts(opts);
    const forged = await buildTx({
      feePayer: relayer.address,
      instructions: [ata, borrow],
      signers: [wallet],
      forged: [wallet.address],
      lifetime: opts.lifetime,
    });
    const sendsBefore = sends.length;
    const e = await expectRejected(relay.relay({ tx_b64: b64Encode(forged.wire) }), {
      code: 'bad_transaction',
      stage: 'gateway',
      status: 400,
    });
    expect(e.detail).toEqual({ rule: 11 });
    expect(sends.length).toBe(sendsBefore);
    expect(await tokenBalance(f.h, await ataOf(wallet.address)).catch(() => 0n)).toBe(0n);
  });

  it('keeps a stranger from spending relayer funds: a transfer-shaped tx is bad_transaction', async () => {
    const pool = await fundedPool(f);
    const relay = relayFor(pool);
    const wallet = await generateKeyPairSigner();
    const thief = await generateKeyPairSigner();
    const opts = await loanOpts(pool, wallet);
    // SystemProgram.transfer(relayer -> thief, 1 lamport), with the borrower signing along.
    const transfer: Instruction = {
      programAddress: SYSTEM_PROGRAM,
      data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
      accounts: [
        { address: relayer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: thief.address, role: AccountRole.WRITABLE },
        { address: wallet.address, role: AccountRole.READONLY_SIGNER },
      ],
    };
    const wire = (
      await buildTx({
        feePayer: relayer.address,
        instructions: [transfer],
        signers: [wallet],
        lifetime: opts.lifetime,
      })
    ).wire;
    const sendsBefore = sends.length;
    const e = await expectRejected(relay.relay({ tx_b64: b64Encode(wire) }), {
      code: 'bad_transaction',
      stage: 'gateway',
      status: 400,
    });
    expect(e.detail).toEqual({ rule: 6 });
    expect(sends.length).toBe(sendsBefore);
    expect(await lamportsOf(f, thief.address)).toBe(0n);
  });
});
