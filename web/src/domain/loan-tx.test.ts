// @vitest-environment node
// The built transaction must satisfy the relayer's own shape check (gateway/src/loan-relay.ts,
// FORMATS §16 rules 1-10 and, through verifyBorrowerSignature, rule 11). That check is the oracle.
import {
  blockhash,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { DEMO_POOL_PROGRAM_ADDRESS, getBorrowInstructionDataDecoder } from '@tio/demo-pool-client';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkLoanTx, verifyBorrowerSignature } from '../../../gateway/src/loan-relay.ts';
import { buildBorrowMessage, buildRepayMessage, signForRelay } from './loan-tx.ts';
import { LOAN_DEPLOYMENT, POOL_0, POOL_1, RELAYER } from '../test-support/fixtures.ts';

const BLOCKHASH = {
  blockhash: blockhash('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi'),
  lastValidBlockHeight: 1000n,
};
const GATEWAY_DEPLOYMENT = { ...LOAN_DEPLOYMENT, pools: [POOL_0, POOL_1] };

let borrower: KeyPairSigner;
beforeAll(async () => {
  borrower = await generateKeyPairSigner();
});

const wireBytes = (b64: string): Uint8Array => Uint8Array.from(getBase64Encoder().encode(b64));

async function borrowWire(pool = POOL_0, amount = 2_000_000n): Promise<Uint8Array> {
  const message = await buildBorrowMessage({
    relayer: RELAYER,
    borrower,
    pool,
    deployment: LOAN_DEPLOYMENT,
    measurementId: 0,
    amount,
    blockhash: BLOCKHASH,
  });
  return wireBytes(await signForRelay(message));
}

async function repayWire(pool = POOL_0): Promise<Uint8Array> {
  const message = await buildRepayMessage({
    relayer: RELAYER,
    borrower,
    pool,
    deployment: LOAN_DEPLOYMENT,
    blockhash: BLOCKHASH,
  });
  return wireBytes(await signForRelay(message));
}

function decode(wire: Uint8Array) {
  const tx = getTransactionDecoder().decode(wire);
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const instructions: readonly Instruction[] = decompileTransactionMessage(compiled).instructions;
  return { tx, compiled, instructions };
}

describe('borrow transaction', () => {
  it('passes the relayer shape check as a borrow for the borrower', async () => {
    const shape = await checkLoanTx(await borrowWire(), RELAYER, GATEWAY_DEPLOYMENT);
    expect(shape).toMatchObject({
      ok: true,
      value: { kind: 'borrow', borrower: borrower.address },
    });
  });

  it('carries a borrower signature that verifies (rule 11)', async () => {
    const shape = await checkLoanTx(await borrowWire(), RELAYER, GATEWAY_DEPLOYMENT);
    expect(shape.ok && (await verifyBorrowerSignature(shape.value))).toBe(true);
  });

  it('is exactly [CreateAssociatedTokenIdempotent, demo_pool.borrow], in that order', async () => {
    const { instructions } = decode(await borrowWire());
    expect(instructions.map((ix) => ix.programAddress)).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      DEMO_POOL_PROGRAM_ADDRESS,
    ]);
  });

  it('encodes the amount in the borrow instruction data', async () => {
    const { instructions } = decode(await borrowWire(POOL_0, 123_456n));
    const data = instructions[1]?.data;
    expect(data && getBorrowInstructionDataDecoder().decode(data).amount).toBe(123_456n);
  });

  it('is a version-0 message with the relayer as fee payer, the borrower second, two signers', async () => {
    const { compiled } = decode(await borrowWire());
    expect(compiled.version).toBe(0);
    expect(compiled.header.numSignerAccounts).toBe(2);
    expect(compiled.staticAccounts.slice(0, 2)).toEqual([RELAYER, borrower.address]);
  });

  it('leaves the relayer signature slot empty and fills the borrower slot with 64 bytes', async () => {
    const { tx } = decode(await borrowWire());
    expect(Object.keys(tx.signatures).toSorted()).toEqual([RELAYER, borrower.address].toSorted());
    expect(tx.signatures[RELAYER]).toBeNull();
    expect(tx.signatures[borrower.address]).toHaveLength(64);
  });

  it('uses no address lookup table', async () => {
    const { compiled } = decode(await borrowWire());
    expect('addressTableLookups' in compiled ? compiled.addressTableLookups : []).toHaveLength(0);
  });

  it('works for the other listed pool', async () => {
    const shape = await checkLoanTx(await borrowWire(POOL_1), RELAYER, GATEWAY_DEPLOYMENT);
    expect(shape.ok).toBe(true);
  });

  it('fits the 1232-byte transaction limit', async () => {
    expect((await borrowWire()).length).toBeLessThanOrEqual(1232);
  });
});

describe('repay transaction', () => {
  it('passes the relayer shape check as a repay for the borrower', async () => {
    const shape = await checkLoanTx(await repayWire(), RELAYER, GATEWAY_DEPLOYMENT);
    expect(shape).toMatchObject({ ok: true, value: { kind: 'repay', borrower: borrower.address } });
    expect(shape.ok && (await verifyBorrowerSignature(shape.value))).toBe(true);
  });

  it('is exactly [demo_pool.repay] with the relayer slot empty', async () => {
    const { instructions, tx } = decode(await repayWire());
    expect(instructions.map((ix) => ix.programAddress)).toEqual([DEMO_POOL_PROGRAM_ADDRESS]);
    expect(tx.signatures[RELAYER]).toBeNull();
    expect(tx.signatures[borrower.address]).toHaveLength(64);
  });
});

describe('signForRelay', () => {
  it('returns standard base64 (no URL alphabet, no padding stripped)', async () => {
    const message = await buildRepayMessage({
      relayer: RELAYER,
      borrower,
      pool: POOL_0,
      deployment: LOAN_DEPLOYMENT,
      blockhash: BLOCKHASH,
    });
    const b64 = await signForRelay(message);
    expect(b64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(b64.length).toBeLessThanOrEqual(2048);
  });
});
