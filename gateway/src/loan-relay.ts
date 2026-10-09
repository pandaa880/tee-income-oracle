/**
 * Shape check for a sponsored loan transaction (FORMATS §16 `POST /v1/loans/relay`).
 *
 * The relayer co-signs and pays for whatever passes this check, so every rule
 * exists to stop a borrower from spending relayer SOL on anything but their
 * own borrow or repay against a listed pool. Pure: no RPC, nothing thrown on
 * malformed input (a failure is a rule number, FORMATS §16 `bad_transaction`).
 * The borrower's signature is rule 11, verified separately by the flow.
 */
import {
  type AccountMeta,
  type Address,
  type CompiledTransactionMessage,
  type CompiledTransactionMessageWithLifetime,
  type Instruction,
  type Transaction,
  address,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  isSignerRole,
  isWritableRole,
  verifySignature,
} from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
} from '@solana-program/token';
import {
  BORROW_DISCRIMINATOR,
  DEMO_POOL_PROGRAM_ADDRESS,
  REPAY_DISCRIMINATOR,
  findLoanPda,
  findVaultPda,
  getBorrowInstructionDataDecoder,
} from '@tio/demo-pool-client';
import { attestationAddress } from '@tio/oracle-client/attest';

import { COMPUTE_BUDGET_PROGRAM } from './relayer.ts';

export type LoanDeployment = {
  mint: Address;
  /** Only these pools are served; empty = nothing is relayable on this cluster. */
  pools: readonly Address[];
  credential: Address;
  schema: Address;
};
export type LoanTxKind = 'borrow' | 'repay';
export type LoanTxShape = { kind: LoanTxKind; borrower: Address; tx: Transaction };
export type ShapeResult = { ok: true; value: LoanTxShape } | { ok: false; rule: number };

/** Borrow measured 23,690 CU and repay 13,204 (FORMATS §14); anything above this is not ours. */
export const MAX_COMPUTE_UNITS = 200_000;

const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const SET_COMPUTE_UNIT_LIMIT_TAG = 2;
const BORROW_DATA_LEN = 16;
const REPAY_DATA_LEN = 8;
const SIGNATURE_LEN = 64;

type Compiled = CompiledTransactionMessage & CompiledTransactionMessageWithLifetime;
type Decoded = { tx: Transaction; compiled: Compiled };
type Body = { kind: LoanTxKind; instructions: readonly Instruction[] };
type Slots = { relayer: Address; borrower: Address; deployment: LoanDeployment };

const rejected = (rule: number): ShapeResult => ({ ok: false, rule });

/**
 * Rule 1 (part 1): the bytes are exactly one version-0 transaction, nothing trailing.
 * Kit's decoders throw on bad input, so they sit inside the try: a malformed body is a
 * rule, never a 500.
 */
function decodeV0(wire: Uint8Array): Decoded | undefined {
  try {
    // The transaction decoder reads `messageBytes` to the end, so the message decoder's
    // end offset is the one that catches trailing bytes.
    const tx = getTransactionDecoder().decode(wire);
    const [compiled, msgEnd] = getCompiledTransactionMessageDecoder().read(tx.messageBytes, 0);
    if (msgEnd !== tx.messageBytes.length || compiled.version !== 0) return undefined;
    return { tx, compiled };
  } catch {
    return undefined;
  }
}

const hasHole = (ix: Instruction): boolean =>
  (ix.accounts ?? []).some((meta: AccountMeta | undefined) => meta === undefined);

/**
 * Rule 1 (part 2, after rule 2 so a lookup table is reported as 2): every instruction's
 * indexes are in range. The decompiler throws on a bad program index and leaves a hole
 * for a bad account index; both are malformed input, not a 500.
 */
function instructionsOf(compiled: Compiled): readonly Instruction[] | undefined {
  try {
    const { instructions } = decompileTransactionMessage(compiled);
    return instructions.some(hasHole) ? undefined : instructions;
  } catch {
    return undefined;
  }
}

const bytesEqual = (a: ArrayLike<number> | undefined, b: ArrayLike<number>): boolean =>
  a !== undefined && a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

const hasDiscriminator = (ix: Instruction, disc: ArrayLike<number>, len: number): boolean =>
  ix.programAddress === DEMO_POOL_PROGRAM_ADDRESS &&
  ix.data?.length === len &&
  bytesEqual(ix.data.subarray(0, disc.length), disc);

/**
 * Rule 5: at most one ComputeBudget instruction, first, a SetComputeUnitLimit within the
 * cap, naming no accounts (the program ignores them, but they would still be write-locked
 * and would let the relayer appear outside the slots rule 10 allows).
 */
function computeBudgetOk(instructions: readonly Instruction[]): boolean {
  const budget = instructions.filter((ix) => ix.programAddress === COMPUTE_BUDGET_PROGRAM);
  if (budget.length === 0) return true;
  if (budget.length > 1 || instructions[0] !== budget[0]) return false;
  const { data, accounts } = budget[0] ?? {};
  if ((accounts?.length ?? 0) > 0) return false;
  if (data === undefined || data.length !== 5 || data[0] !== SET_COMPUTE_UNIT_LIMIT_TAG)
    return false;
  const units = new DataView(new Uint8Array(data).buffer).getUint32(1, true);
  return units <= MAX_COMPUTE_UNITS;
}

/** Rule 6: after the optional compute-unit limit, exactly `[ata, borrow]` or `[repay]`. */
function classifyBody(instructions: readonly Instruction[]): Body | undefined {
  const body =
    instructions[0]?.programAddress === COMPUTE_BUDGET_PROGRAM
      ? instructions.slice(1)
      : instructions;
  const [first, second] = body;
  if (
    body.length === 2 &&
    first?.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS &&
    second !== undefined &&
    hasDiscriminator(second, BORROW_DISCRIMINATOR, BORROW_DATA_LEN)
  ) {
    return { kind: 'borrow', instructions: body };
  }
  if (
    body.length === 1 &&
    first !== undefined &&
    hasDiscriminator(first, REPAY_DISCRIMINATOR, REPAY_DATA_LEN)
  ) {
    return { kind: 'repay', instructions: body };
  }
  return undefined;
}

type Expect = { at: number; address: Address; signer?: boolean; writable?: boolean };

/** Every `expected` slot holds that address, with that signer / writable role when stated. */
function accountsMatch(accounts: readonly AccountMeta[], expected: readonly Expect[]): boolean {
  return expected.every((e) => {
    const meta = accounts[e.at];
    if (meta === undefined || meta.address !== e.address) return false;
    if (e.signer !== undefined && isSignerRole(meta.role) !== e.signer) return false;
    if (e.writable !== undefined && isWritableRole(meta.role) !== e.writable) return false;
    return true;
  });
}

async function poolAccounts(pool: Address, borrower: Address, s: Slots, mint: Address) {
  const [vault] = await findVaultPda({ pool });
  const [loan] = await findLoanPda({ pool, borrower });
  const [ata] = await findAssociatedTokenPda({
    owner: borrower,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const attestation = await attestationAddress(
    s.deployment.credential,
    s.deployment.schema,
    borrower,
  );
  return { vault, loan, ata, attestation };
}

/** Rule 7: `CreateAssociatedTokenIdempotent(payer = relayer, owner = borrower, mint)`. */
async function ataOk(ix: Instruction, s: Slots, mint: Address): Promise<boolean> {
  const accounts = ix.accounts ?? [];
  if (accounts.length !== 6 || !bytesEqual(ix.data, [1])) return false;
  const [ata] = await findAssociatedTokenPda({
    owner: s.borrower,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return accountsMatch(accounts, [
    { at: 0, address: s.relayer, signer: true, writable: true },
    { at: 1, address: ata, writable: true },
    { at: 2, address: s.borrower },
    { at: 3, address: mint },
    { at: 4, address: SYSTEM_PROGRAM },
    { at: 5, address: TOKEN_PROGRAM_ADDRESS },
  ]);
}

/** Rule 8: `borrow(amount > 0)` on a listed pool, paid by the relayer, every PDA the borrower's own. */
async function borrowOk(ix: Instruction, s: Slots, mint: Address): Promise<boolean> {
  const accounts = ix.accounts ?? [];
  const pool = accounts[2]?.address;
  if (accounts.length !== 11 || pool === undefined || !s.deployment.pools.includes(pool))
    return false;
  if (getBorrowInstructionDataDecoder().decode(ix.data ?? new Uint8Array()).amount <= 0n)
    return false;
  const pda = await poolAccounts(pool, s.borrower, s, mint);
  return accountsMatch(accounts, [
    { at: 0, address: s.relayer, signer: true, writable: true },
    { at: 1, address: s.borrower, signer: true },
    { at: 3, address: mint },
    { at: 4, address: pda.vault, writable: true },
    { at: 5, address: pda.ata, writable: true },
    { at: 6, address: pda.loan, writable: true },
    { at: 7, address: pda.attestation },
    // 8: enclave_entry — any address; the program checks owner and type.
    { at: 9, address: TOKEN_PROGRAM_ADDRESS },
    { at: 10, address: SYSTEM_PROGRAM },
  ]);
}

/** Rule 9: `repay()` on a listed pool whose Loan rent goes back to the relayer. */
async function repayOk(ix: Instruction, s: Slots, mint: Address): Promise<boolean> {
  const accounts = ix.accounts ?? [];
  const pool = accounts[1]?.address;
  if (accounts.length !== 8 || pool === undefined || !s.deployment.pools.includes(pool))
    return false;
  const pda = await poolAccounts(pool, s.borrower, s, mint);
  return accountsMatch(accounts, [
    { at: 0, address: s.borrower, signer: true },
    { at: 2, address: mint },
    { at: 3, address: pda.vault, writable: true },
    { at: 4, address: pda.ata, writable: true },
    { at: 5, address: pda.loan, writable: true },
    // The relayer is the fee payer, so at message level this slot carries its signer role too.
    { at: 6, address: s.relayer, writable: true },
    { at: 7, address: TOKEN_PROGRAM_ADDRESS },
  ]);
}

/** Slots where the relayer may legitimately appear, per instruction kind and position. */
const RELAYER_SLOTS: Record<LoanTxKind, readonly (readonly number[])[]> = {
  borrow: [[0], [0]], // ata payer, borrow payer
  repay: [[6]], // rent_payer
};

/** Rule 10: the relayer appears nowhere else (no instruction may read or move its account). */
function relayerOnlyWherePaying(body: Body, relayer: Address): boolean {
  return body.instructions.every((ix, i) =>
    (ix.accounts ?? []).every(
      (meta, at) =>
        meta.address !== relayer || (RELAYER_SLOTS[body.kind][i]?.includes(at) ?? false),
    ),
  );
}

async function bodyOk(body: Body, s: Slots): Promise<number | undefined> {
  const { mint } = s.deployment;
  if (body.kind === 'borrow') {
    const [ata, borrow] = body.instructions;
    if (ata === undefined || !(await ataOk(ata, s, mint))) return 7;
    if (borrow === undefined || !(await borrowOk(borrow, s, mint))) return 8;
  } else {
    const [repay] = body.instructions;
    if (repay === undefined || !(await repayOk(repay, s, mint))) return 9;
  }
  return relayerOnlyWherePaying(body, s.relayer) ? undefined : 10;
}

/** Rules 1–10. Rule 11 (the borrower's signature) is `verifyBorrowerSignature`. */
export async function checkLoanTx(
  wire: Uint8Array,
  relayer: Address,
  deployment: LoanDeployment,
): Promise<ShapeResult> {
  const decoded = decodeV0(wire);
  if (decoded === undefined) return rejected(1);
  const { tx, compiled } = decoded;
  const lookups = 'addressTableLookups' in compiled ? compiled.addressTableLookups : undefined;
  if ((lookups?.length ?? 0) > 0) return rejected(2);
  const instructions = instructionsOf(compiled);
  if (instructions === undefined) return rejected(1);
  const [feePayer, borrower] = compiled.staticAccounts;
  if (
    compiled.header.numSignerAccounts !== 2 ||
    feePayer !== relayer ||
    borrower === undefined ||
    borrower === relayer
  ) {
    return rejected(3);
  }
  const borrowerSig = tx.signatures[borrower];
  if (
    Object.keys(tx.signatures).length !== 2 ||
    tx.signatures[relayer] !== null ||
    borrowerSig?.length !== SIGNATURE_LEN
  ) {
    return rejected(4);
  }
  if (!computeBudgetOk(instructions)) return rejected(5);
  const body = classifyBody(instructions);
  if (body === undefined) return rejected(6);
  const failed = await bodyOk(body, { relayer, borrower, deployment });
  if (failed !== undefined) return rejected(failed);
  return { ok: true, value: { kind: body.kind, borrower, tx } };
}

/** Rule 11: the borrower slot holds the borrower's Ed25519 signature over the message bytes. */
export async function verifyBorrowerSignature(shape: LoanTxShape): Promise<boolean> {
  const signature = shape.tx.signatures[shape.borrower];
  if (signature === null || signature === undefined) return false;
  try {
    return await verifySignature(
      await getPublicKeyFromAddress(shape.borrower),
      signature,
      shape.tx.messageBytes,
    );
  } catch {
    return false; // not a valid Ed25519 point
  }
}

export type SimulationDetail =
  | { index: number; custom: number }
  | { index: number; kind: string }
  | { kind: string };

/** Error names are identifiers; anything else from the node is reported as `unknown`. */
const ERROR_NAME = /^[A-Za-z]{1,40}$/;
const UNKNOWN: SimulationDetail = { kind: 'unknown' };

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null;
const isList = (v: unknown): v is readonly unknown[] => Array.isArray(v);
/** Kit's RPC upcasts JSON integers to bigint; accept both, as a safe non-negative integer. */
function asIndex(v: unknown): number | undefined {
  if (typeof v === 'bigint' && v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** RPC `TransactionError` for a failing instruction: `[index, "Name" | { Custom: code }]`. */
function instructionErrorOf(err: unknown): readonly [number, unknown] | undefined {
  if (!isRecord(err)) return undefined;
  const list = err['InstructionError'];
  if (!isList(list) || list.length !== 2) return undefined;
  const index = asIndex(list[0]);
  return index === undefined ? undefined : [index, list[1]];
}

const nameOf = (v: unknown): string =>
  typeof v === 'string' && ERROR_NAME.test(v) ? v : 'unknown';

/**
 * The machine-readable part of a simulation `err` (RPC `TransactionError`):
 * `{ InstructionError: [index, { Custom: code }] }` → the program's code (an Anchor
 * error such as 6008 PolicyMismatch); a named error keeps its name; anything else is `unknown`.
 */
export function simulationDetail(err: unknown): SimulationDetail {
  if (typeof err === 'string') return { kind: nameOf(err) };
  const failing = instructionErrorOf(err);
  if (failing === undefined) return UNKNOWN;
  const [index, inner] = failing;
  const custom = isRecord(inner) ? asIndex(inner['Custom']) : undefined;
  if (custom !== undefined) return { index, custom };
  if (typeof inner === 'string') return { index, kind: nameOf(inner) };
  return UNKNOWN;
}
