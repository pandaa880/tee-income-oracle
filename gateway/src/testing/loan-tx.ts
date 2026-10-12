// Test code only. Builds browser-style loan transactions (fee payer = relayer, relayer slot
// empty, borrower signed) and lets a test break exactly one shape rule at a time.
import {
  type AccountMeta,
  type CompiledTransactionMessage,
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type SignatureBytes,
  type Transaction,
  type TransactionMessageBytes,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createSignableMessage,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress } from '@tio/oracle-client/attest';
import { getBorrowInstructionAsync, getRepayInstructionAsync } from '@tio/demo-pool-client';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';

import type { LoanDeployment } from '../loan-relay.ts';

export const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const DEFAULT_AMOUNT = 1_000_000n;

// Valid base58 addresses; the shape check never asks whether they are on the curve.
export const POOL = address('Sysvar1nstructions1111111111111111111111111');
export const MINT = address('So11111111111111111111111111111111111111112');
export const CREDENTIAL = address('F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7');
export const SCHEMA = address('991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV');
export type Lifetime = Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0];
/** For tests that never reach a cluster. */
const OFFLINE_LIFETIME: Lifetime = {
  blockhash: blockhash('4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM'),
  lastValidBlockHeight: 1n,
};

export function testDeployment(over: Partial<LoanDeployment> = {}): LoanDeployment {
  return { mint: MINT, pools: [POOL], credential: CREDENTIAL, schema: SCHEMA, ...over };
}

// --- low level -------------------------------------------------------------

export type BuildTxOpts = {
  feePayer: Address;
  instructions: readonly Instruction[];
  /** Keypairs that sign. A required signer without a keypair here gets an empty slot. */
  signers: readonly KeyPairSigner[];
  /** Signers whose signature is made over different bytes (a forgery). */
  forged?: readonly Address[];
  version?: 0 | 'legacy';
  /** A real blockhash for tests that send. */
  lifetime?: Lifetime;
  /** Adds one address-table lookup (v0 only). */
  lookupTable?: boolean;
};

export type BuiltTx = { wire: Uint8Array; tx: Transaction };

export async function buildTx(o: BuildTxOpts): Promise<BuiltTx> {
  const message = pipe(
    createTransactionMessage({ version: o.version ?? 0 }),
    (m) => setTransactionMessageFeePayer(o.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(o.lifetime ?? OFFLINE_LIFETIME, m),
    (m) => appendTransactionMessageInstructions(o.instructions, m),
  );
  const compiled = compileTransaction(message);
  let messageBytes = compiled.messageBytes;
  if (o.lookupTable === true) {
    const decoded = getCompiledTransactionMessageDecoder().decode(messageBytes);
    if (decoded.version !== 0) throw new Error('lookup tables need a v0 message');
    const withLookup: CompiledTransactionMessage = {
      ...decoded,
      addressTableLookups: [
        { lookupTableAddress: SYSTEM_PROGRAM, readonlyIndexes: [0], writableIndexes: [] },
      ],
    };
    // The only way to forge a message with a lookup table the signer never saw: re-encode by hand.
    const forged = new Uint8Array(getCompiledTransactionMessageEncoder().encode(withLookup));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    messageBytes = forged as unknown as TransactionMessageBytes;
  }
  const signatures: Record<string, SignatureBytes | null> = {};
  for (const slot of Object.keys(compiled.signatures)) {
    const signer = o.signers.find((s) => s.address === slot);
    if (signer === undefined) {
      signatures[slot] = null;
      continue;
    }
    const over = o.forged?.includes(signer.address) === true ? flip(messageBytes) : messageBytes;
    const [signed] = await signer.signMessages([createSignableMessage(new Uint8Array(over))]);
    // Keyed by the key's real address (an impostor signer carries another address on purpose).
    signatures[slot] = Object.values(signed ?? {})[0] ?? null;
  }
  const tx = { messageBytes, signatures } as Transaction;
  return { wire: new Uint8Array(getTransactionEncoder().encode(tx)), tx };
}

function flip(bytes: ReadonlyUint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
  return copy;
}

// --- instruction edits -----------------------------------------------------

export function withAccount(ix: Instruction, index: number, meta: AccountMeta): Instruction {
  const accounts = [...(ix.accounts ?? [])];
  accounts[index] = meta;
  return { ...ix, accounts };
}

export function withAddress(ix: Instruction, index: number, at: Address): Instruction {
  const old = ix.accounts?.[index];
  if (old === undefined) throw new Error(`no account ${index}`);
  return withAccount(ix, index, { address: at, role: old.role });
}

export function withExtraAccount(ix: Instruction, meta: AccountMeta): Instruction {
  return { ...ix, accounts: [...(ix.accounts ?? []), meta] };
}

export function withoutLastAccount(ix: Instruction): Instruction {
  return { ...ix, accounts: (ix.accounts ?? []).slice(0, -1) };
}

export function withData(ix: Instruction, data: Uint8Array): Instruction {
  return { ...ix, data };
}

export function withProgram(ix: Instruction, programAddress: Address): Instruction {
  return { ...ix, programAddress };
}

export function readonly(at: Address): AccountMeta {
  return { address: at, role: AccountRole.READONLY };
}

// --- compute budget (by hand, mirror of relayer.ts) -------------------------

export function computeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data };
}

export function computeUnitPrice(microLamports: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data };
}

// --- the two valid shapes --------------------------------------------------

export type LoanOpts = {
  /** Registry id of the enclave that signed the attestation (the `enclave_entry` account). */
  measurementId?: number;
  relayer: Address;
  borrower: KeyPairSigner;
  deployment: LoanDeployment;
  pool: Address;
  amount?: bigint;
  /** Prepends `SetComputeUnitLimit(computeUnits)`. */
  computeUnits?: number;
  lifetime?: Lifetime;
};

export type BorrowParts = { ata: Instruction; borrow: Instruction; borrowerToken: Address };

export async function borrowParts(o: LoanOpts): Promise<BorrowParts> {
  const wallet = o.borrower.address;
  const [borrowerToken] = await findAssociatedTokenPda({
    owner: wallet,
    mint: o.deployment.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const relayer = createNoopSigner(o.relayer);
  const ata = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: relayer,
    owner: wallet,
    mint: o.deployment.mint,
  });
  const [enclaveEntry] = await findEnclaveEntryPda({ measurementId: o.measurementId ?? 1 });
  const borrow = await getBorrowInstructionAsync({
    payer: relayer,
    borrower: createNoopSigner(wallet),
    pool: o.pool,
    mint: o.deployment.mint,
    borrowerToken,
    attestation: await attestationAddress(o.deployment.credential, o.deployment.schema, wallet),
    enclaveEntry,
    amount: o.amount ?? DEFAULT_AMOUNT,
  });
  return { ata, borrow, borrowerToken };
}

export async function repayParts(
  o: LoanOpts,
): Promise<{ repay: Instruction; borrowerToken: Address }> {
  const wallet = o.borrower.address;
  const [borrowerToken] = await findAssociatedTokenPda({
    owner: wallet,
    mint: o.deployment.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const repay = await getRepayInstructionAsync({
    borrower: createNoopSigner(wallet),
    pool: o.pool,
    mint: o.deployment.mint,
    borrowerToken,
    rentPayer: o.relayer,
  });
  return { repay, borrowerToken };
}

export type LoanTx = BuiltTx & { borrower: KeyPairSigner; instructions: readonly Instruction[] };

function leading(o: LoanOpts): Instruction[] {
  return o.computeUnits === undefined ? [] : [computeUnitLimit(o.computeUnits)];
}

async function finish(o: LoanOpts, instructions: readonly Instruction[]): Promise<LoanTx> {
  const built = await buildTx({
    feePayer: o.relayer,
    instructions,
    signers: [o.borrower],
    ...(o.lifetime === undefined ? {} : { lifetime: o.lifetime }),
  });
  return { ...built, borrower: o.borrower, instructions };
}

export async function buildBorrowTx(o: LoanOpts): Promise<LoanTx> {
  const { ata, borrow } = await borrowParts(o);
  return finish(o, [...leading(o), ata, borrow]);
}

export async function buildRepayTx(o: LoanOpts): Promise<LoanTx> {
  const { repay } = await repayParts(o);
  return finish(o, [...leading(o), repay]);
}

/** Same builders, any instruction list: the tx a test wants to break. */
export function buildWith(o: LoanOpts, instructions: readonly Instruction[]): Promise<LoanTx> {
  return finish(o, instructions);
}

export { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS };
