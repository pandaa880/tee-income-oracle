// Shared fixture for the demo-pool tests: the oracle fixture (surfnet, oracle,
// SAS, credential/schema, one registered enclave) plus the pool program, a
// mint, and small builders for pools, borrowers, real attestations and the
// four pool instructions. Every builder takes per-account overrides so a
// negative test changes exactly one thing.
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  AccountRole,
  generateKeyPairSigner,
  isWritableRole,
} from '@solana/kit';
import {
  DEMO_POOL_PROGRAM_ADDRESS,
  type PoolParamsArgs,
  findLoanPda,
  findPoolPda,
  findVaultPda,
  getBorrowInstructionAsync,
  getCreatePoolInstructionAsync,
  getRepayInstructionAsync,
  getUpdatePoolInstruction,
} from '@tio/demo-pool-client';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import {
  SAS_PROGRAM_ID,
  attestationAddress,
  fetchRaw,
  freshClock,
  plantAccount,
  type EnclaveKey,
  SAS_DATA_OFFSET,
  SAS_EXPIRY_OFFSET,
  SAS_SIGNER_OFFSET,
} from '@tio/oracle-tests/attest';
import {
  type Case,
  type Failure,
  type Fixture,
  freshKey,
  newCase,
  registerKey,
  sendExpectingFailure,
  startFixture,
  submit,
} from '@tio/oracle-tests/attest-fixture';
import { send } from '@tio/oracle-tests/harness';
import { fileURLToPath } from 'node:url';
import { createAta, createMint, mintTo } from './token.ts';

const POOL_SO_PATH = fileURLToPath(
  new URL('../../../../target/deploy/demo_pool.so', import.meta.url),
);
const LAMPORTS_PER_SOL = 1_000_000_000;

export const DAY = 86_400;
/** Enough tokens that no borrow in a test runs the vault dry. */
export const BIG_VAULT = 1_000_000_000_000n;

// Byte offsets inside the stored SAS attestation (FORMATS §7). Payload fields:
// tier @0, window_from @75, window_to @79.
export const SAS_OFFSET = {
  discriminator: 0,
  tier: SAS_DATA_OFFSET,
  windowFrom: SAS_DATA_OFFSET + 75,
  windowTo: SAS_DATA_OFFSET + 79,
  signer: SAS_SIGNER_OFFSET,
  expiry: SAS_EXPIRY_OFFSET,
} as const;

export type PoolFixture = Fixture & { mintAuthority: KeyPairSigner; mint: Address };

/** Oracle fixture + pool program deployed + a 6-decimal mint. */
export async function startPoolFixture(): Promise<PoolFixture> {
  const f = await startFixture();
  f.h.surfnet.deploy({ programId: DEMO_POOL_PROGRAM_ADDRESS, soPath: POOL_SO_PATH });
  const mintAuthority = await generateKeyPairSigner();
  const mint = await createMint(f.h, mintAuthority.address);
  return { ...f, mintAuthority, mint };
}

export async function fundedSigner(f: PoolFixture, sol = 10): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  f.h.surfnet.fundSol(signer.address, sol * LAMPORTS_PER_SOL);
  return signer;
}

export async function lamportsOf(f: PoolFixture, at: Address): Promise<bigint> {
  return (await f.h.rpc.getBalance(at).send()).value;
}

/** Bitmap with bit `id` set for every id: byte `id / 8`, bit `id % 8` (LSB first). */
export function approve(...ids: number[]): Uint8Array {
  const bitmap = new Uint8Array(32);
  for (const id of ids) {
    const byte = Math.floor(id / 8);
    bitmap[byte] = (bitmap[byte] ?? 0) | (1 << (id % 8));
  }
  return bitmap;
}

/**
 * Default pool rules: policy 0x11 x 32 (what `newCase` signs), tier limits
 * 3 / 2 / 1 tokens, attestation <= 1 h old, statement ended <= 30 d before
 * issue and spans >= 180 d, only the fixture's registered enclave approved.
 */
export function poolParams(
  f: PoolFixture,
  overrides: Partial<PoolParamsArgs> = {},
): PoolParamsArgs {
  return {
    policyHash: new Uint8Array(32).fill(0x11),
    tierLimits: [3_000_000n, 2_000_000n, 1_000_000n],
    maxAgeSecs: 3_600,
    maxWindowAgeSecs: 30 * DAY,
    minWindowSecs: 180 * DAY,
    approvedMeasurements: approve(f.entryId),
    ...overrides,
  };
}

/** A registered enclave key that nothing else in the fixture uses (safe to revoke). */
export type Enclave = { key: EnclaveKey; entryId: number };

export async function newEnclave(f: PoolFixture): Promise<Enclave> {
  const key = freshKey();
  return { key, entryId: await registerKey(f.h, key) };
}

export async function entryAddress(entryId: number): Promise<Address> {
  const [address] = await findEnclaveEntryPda({ measurementId: entryId });
  return address;
}

/** The instruction with `address` demoted to a non-signer (keeps writability). */
export function demoteSigner(instruction: Instruction, address: Address): Instruction {
  const accounts = (instruction.accounts ?? []).map((meta) =>
    meta.address === address
      ? {
          address,
          role: isWritableRole(meta.role) ? AccountRole.WRITABLE : AccountRole.READONLY,
        }
      : meta,
  );
  return { ...instruction, accounts };
}

// --- pools -------------------------------------------------------------

export type PoolRef = {
  address: Address;
  vault: Address;
  admin: KeyPairSigner;
  poolId: number;
  mint: Address;
  credential: Address;
  schema: Address;
  params: PoolParamsArgs;
};

export type CreatePoolOpts = {
  /** Default: a fresh funded signer, so pool ids never collide between tests. */
  admin?: KeyPairSigner;
  poolId?: number;
  params?: Partial<PoolParamsArgs>;
  mint?: Address;
  credential?: Address;
  schema?: Address;
  accounts?: Partial<{ pool: Address; vault: Address }>;
  /** Pass the admin as a non-signer (negative test). */
  adminSigns?: boolean;
};

export type BuiltCreate = { pool: PoolRef; instruction: Instruction; feePayer: KeyPairSigner };

export async function buildCreatePool(
  f: PoolFixture,
  o: CreatePoolOpts = {},
): Promise<BuiltCreate> {
  const admin = o.admin ?? (await fundedSigner(f));
  const poolId = o.poolId ?? 0;
  const [address] = await findPoolPda({ admin: admin.address, poolId });
  const [vault] = await findVaultPda({ pool: address });
  const pool: PoolRef = {
    address,
    vault,
    admin,
    poolId,
    mint: o.mint ?? f.mint,
    credential: o.credential ?? f.credential,
    schema: o.schema ?? f.schema,
    params: poolParams(f, o.params),
  };
  const instruction = await getCreatePoolInstructionAsync({
    admin,
    pool: o.accounts?.pool ?? address,
    vault: o.accounts?.vault ?? vault,
    mint: pool.mint,
    poolId,
    credential: pool.credential,
    schema: pool.schema,
    params: pool.params,
  });
  const signs = o.adminSigns !== false;
  return {
    pool,
    instruction: signs ? instruction : demoteSigner(instruction, admin.address),
    feePayer: signs ? admin : f.h.payer,
  };
}

/** Sends `create_pool` and returns the pool; use `createPoolSignature` for the signature. */
export async function createPool(f: PoolFixture, o: CreatePoolOpts = {}): Promise<PoolRef> {
  const built = await buildCreatePool(f, o);
  await send(f.h, built.feePayer, [built.instruction]);
  return built.pool;
}

export async function createPoolSignature(
  f: PoolFixture,
  o: CreatePoolOpts = {},
): Promise<{ pool: PoolRef; signature: string }> {
  const built = await buildCreatePool(f, o);
  const signature = await send(f.h, built.feePayer, [built.instruction]);
  return { pool: built.pool, signature };
}

export async function createPoolFailure(f: PoolFixture, o: CreatePoolOpts = {}): Promise<Failure> {
  const built = await buildCreatePool(f, o);
  return sendExpectingFailure(f, built.feePayer, [built.instruction]);
}

export async function fundVault(f: PoolFixture, pool: PoolRef, amount: bigint): Promise<void> {
  await mintTo(f.h, pool.mint, f.mintAuthority, pool.vault, amount);
}

/** `create_pool` then a vault holding `BIG_VAULT` tokens. */
export async function fundedPool(f: PoolFixture, o: CreatePoolOpts = {}): Promise<PoolRef> {
  const pool = await createPool(f, o);
  await fundVault(f, pool, BIG_VAULT);
  return pool;
}

export function updatePoolInstruction(
  pool: PoolRef,
  params: PoolParamsArgs,
  admin: KeyPairSigner = pool.admin,
): Instruction {
  return getUpdatePoolInstruction({ admin, pool: pool.address, params });
}

// --- borrowers and attestations ------------------------------------------

export type Borrower = {
  signer: KeyPairSigner;
  /** The borrower's associated token account for the fixture mint. */
  token: Address;
  /** Registry id of the enclave that signed the borrower's attestation. */
  entryId: number;
  /** Clock reading at which the attestation was issued (0 before `attest`). */
  now: bigint;
};

/** A funded signer with an empty token account; no attestation yet. */
export async function newBorrower(f: PoolFixture): Promise<Borrower> {
  const signer = await fundedSigner(f);
  const token = await createAta(f.h, signer, signer.address, f.mint);
  return { signer, token, entryId: f.entryId, now: 0n };
}

export type AttestOptions = {
  /** Reuse this clock reading (the clock must already be there); default: a fresh clock era. */
  now?: bigint;
  tier?: number;
  policyHash?: Uint8Array;
  /** Statement window relative to `now`: ended `ageSecs` ago, spans `lengthSecs`. */
  window?: { ageSecs: number; lengthSecs: number };
  enclave?: Enclave;
};

/**
 * A REAL attestation through the oracle for `wallet`. Defaults: tier A,
 * statement window `now - 200 d .. now - 1 d`, the fixture's enclave.
 */
export async function attest(
  f: PoolFixture,
  wallet: Address,
  o: AttestOptions = {},
): Promise<Case> {
  const now = o.now ?? (await freshClock(f.h));
  const window = o.window ?? { ageSecs: DAY, lengthSecs: 199 * DAY };
  const windowTo = Number(now) - window.ageSecs;
  const c = await newCase(f, {
    now,
    wallet,
    payload: {
      windowFrom: windowTo - window.lengthSecs,
      windowTo,
      ...(o.tier === undefined ? {} : { tier: o.tier }),
      ...(o.policyHash === undefined ? {} : { policyHash: o.policyHash }),
    },
    ...(o.enclave === undefined ? {} : { key: o.enclave.key, entryId: o.enclave.entryId }),
  });
  await submit(f, c.params);
  return c;
}

/** `newBorrower` + `attest`: a borrower holding a fresh attestation. */
export async function prepare(f: PoolFixture, o: AttestOptions = {}): Promise<Borrower> {
  const borrower = await newBorrower(f);
  const c = await attest(f, borrower.signer.address, o);
  return { ...borrower, entryId: c.params.entryId, now: c.now };
}

/**
 * Re-plants the borrower's real attestation after `transform` changed a copy
 * of its bytes (same address, same lamports, owner SAS unless `owner` is given).
 */
export async function plantAttestationBytes(
  f: PoolFixture,
  wallet: Address,
  transform: (copy: Uint8Array) => Uint8Array,
  owner: Address = SAS_PROGRAM_ID,
): Promise<void> {
  const at = await attestationAddress(f.credential, f.schema, wallet);
  const raw = await fetchRaw(f.h, at);
  if (raw === undefined) {
    throw new Error('no attestation to plant over');
  }
  plantAccount(f.h, at, owner, transform(new Uint8Array(raw.data)), Number(raw.lamports));
}

/** Same as `plantAttestationBytes` for edits that keep the length. */
export async function plantAttestation(
  f: PoolFixture,
  wallet: Address,
  edit: (data: Uint8Array) => void,
  owner: Address = SAS_PROGRAM_ID,
): Promise<void> {
  await plantAttestationBytes(
    f,
    wallet,
    (copy) => {
      edit(copy);
      return copy;
    },
    owner,
  );
}

export function setU32(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value, true);
}

export function setI64(data: Uint8Array, offset: number, value: bigint): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigInt64(offset, value, true);
}

export function getU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

// --- borrow / repay ----------------------------------------------------

export async function loanAddress(pool: PoolRef, borrower: Borrower): Promise<Address> {
  const [loan] = await findLoanPda({ pool: pool.address, borrower: borrower.signer.address });
  return loan;
}

export type BorrowOpts = {
  pool: PoolRef;
  borrower: Borrower;
  amount: bigint;
  /** Default: the borrower. */
  payer?: KeyPairSigner;
  /** Replace single accounts. Defaults are the correct ones for `pool` and `borrower`. */
  accounts?: Partial<{
    mint: Address;
    vault: Address;
    borrowerToken: Address;
    loan: Address;
    attestation: Address;
    enclaveEntry: Address;
  }>;
  /** Pass the borrower as a non-signer (negative test; needs a different `payer`). */
  borrowerSigns?: boolean;
};

export async function borrowIx(o: BorrowOpts): Promise<Instruction> {
  const { pool, borrower } = o;
  const a = o.accounts ?? {};
  const wallet = borrower.signer.address;
  const instruction = await getBorrowInstructionAsync({
    payer: o.payer ?? borrower.signer,
    borrower: borrower.signer,
    pool: pool.address,
    mint: a.mint ?? pool.mint,
    vault: a.vault ?? pool.vault,
    borrowerToken: a.borrowerToken ?? borrower.token,
    loan: a.loan ?? (await loanAddress(pool, borrower)),
    attestation: a.attestation ?? (await attestationAddress(pool.credential, pool.schema, wallet)),
    enclaveEntry: a.enclaveEntry ?? (await entryAddress(borrower.entryId)),
    amount: o.amount,
  });
  return o.borrowerSigns === false ? demoteSigner(instruction, wallet) : instruction;
}

/** Sends `borrow`; returns the signature. */
export async function borrow(f: PoolFixture, o: BorrowOpts): Promise<string> {
  return send(f.h, o.payer ?? o.borrower.signer, [await borrowIx(o)]);
}

export async function borrowFailure(f: PoolFixture, o: BorrowOpts): Promise<Failure> {
  return sendExpectingFailure(f, o.payer ?? o.borrower.signer, [await borrowIx(o)]);
}

export type RepayOpts = {
  pool: PoolRef;
  borrower: Borrower;
  /** Who gets the loan's rent back; default: the borrower. */
  rentPayer?: Address;
  /** Default: the borrower. Pass `f.h.payer` to keep fees out of balance checks. */
  feePayer?: KeyPairSigner;
  accounts?: Partial<{ mint: Address; vault: Address; borrowerToken: Address; loan: Address }>;
  borrowerSigns?: boolean;
};

export async function repayIx(o: RepayOpts): Promise<Instruction> {
  const { pool, borrower } = o;
  const a = o.accounts ?? {};
  const instruction = await getRepayInstructionAsync({
    borrower: borrower.signer,
    pool: pool.address,
    mint: a.mint ?? pool.mint,
    vault: a.vault ?? pool.vault,
    borrowerToken: a.borrowerToken ?? borrower.token,
    loan: a.loan ?? (await loanAddress(pool, borrower)),
    rentPayer: o.rentPayer ?? borrower.signer.address,
  });
  return o.borrowerSigns === false
    ? demoteSigner(instruction, borrower.signer.address)
    : instruction;
}

/** Sends `repay`; returns the signature. */
export async function repay(f: PoolFixture, o: RepayOpts): Promise<string> {
  return send(f.h, o.feePayer ?? o.borrower.signer, [await repayIx(o)]);
}

export async function repayFailure(f: PoolFixture, o: RepayOpts): Promise<Failure> {
  return sendExpectingFailure(f, o.feePayer ?? o.borrower.signer, [await repayIx(o)]);
}
