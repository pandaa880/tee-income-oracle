/**
 * The loan-relay shape check (pure): one valid borrow, one valid repay, and one fixture per
 * rule that breaks ONLY that rule, so deleting any rule turns a test red. Rules are numbered as
 * in plan 5a-1 Part A.
 */
import {
  AccountRole,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type TransactionMessageBytes,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_COMPUTE_UNITS,
  type ShapeResult,
  checkLoanTx,
  simulationDetail,
  verifyBorrowerSignature,
} from './loan-relay.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  MINT,
  POOL,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM_ADDRESS,
  borrowParts,
  buildBorrowTx,
  buildRepayTx,
  buildTx,
  computeUnitLimit,
  computeUnitPrice,
  readonly,
  repayParts,
  testDeployment,
  withAccount,
  withAddress,
  withData,
  withExtraAccount,
  withProgram,
  withoutLastAccount,
  type BuildTxOpts,
  type LoanOpts,
} from './testing/loan-tx.ts';

type World = {
  relayer: KeyPairSigner;
  borrower: KeyPairSigner;
  other: KeyPairSigner;
  opts: LoanOpts;
  /** Builds with fee payer = relayer and only the borrower signing, unless `over` says otherwise. */
  tx: (instructions: readonly Instruction[], over?: Partial<BuildTxOpts>) => Promise<Uint8Array>;
  check: (wire: Uint8Array) => Promise<ShapeResult>;
};

let w: World;

beforeAll(async () => {
  const [relayer, borrower, other] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const deployment = testDeployment();
  const opts: LoanOpts = { relayer: relayer.address, borrower, deployment, pool: POOL };
  w = {
    relayer,
    borrower,
    other,
    opts,
    tx: async (instructions, over = {}) =>
      (
        await buildTx({
          feePayer: relayer.address,
          instructions,
          signers: [borrower],
          ...over,
        })
      ).wire,
    check: (wire) => checkLoanTx(wire, relayer.address, deployment),
  };
});

function rejectedRule(r: ShapeResult): number | 'accepted' {
  return r.ok ? 'accepted' : r.rule;
}

type CompiledIx = { programAddressIndex: number; accountIndices?: number[] };

/** Re-encodes `wire` after `mutate` edited its compiled instructions (indexes kit never emits). */
function reencoded(wire: Uint8Array, mutate: (ixs: CompiledIx[]) => void): Uint8Array {
  const tx = getTransactionDecoder().decode(wire);
  const compiled = structuredClone(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
  mutate((compiled as { instructions: CompiledIx[] }).instructions);
  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    compiled,
  ) as unknown as TransactionMessageBytes;
  return new Uint8Array(
    getTransactionEncoder().encode({ messageBytes, signatures: tx.signatures }),
  );
}

const GARBAGE = [
  ['empty bytes', new Uint8Array(0)],
  ['three bytes', new Uint8Array([1, 2, 3])],
  ['random 200 bytes', Uint8Array.from({ length: 200 }, (_, i) => (i * 37 + 11) % 256)],
] as const;

describe('checkLoanTx: accepted shapes', () => {
  it('accepts a valid borrow and reports kind, borrower and the decoded tx', async () => {
    const built = await buildBorrowTx(w.opts);
    const r = await w.check(built.wire);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('borrow');
    expect(r.value.borrower).toBe(w.borrower.address);
    expect(r.value.tx.signatures[w.relayer.address]).toBeNull();
    expect(r.value.tx.signatures[w.borrower.address]?.length).toBe(64);
  });

  it('accepts a valid repay', async () => {
    const r = await w.check((await buildRepayTx(w.opts)).wire);
    expect(r.ok && r.value.kind).toBe('repay');
    expect(r.ok && r.value.borrower).toBe(w.borrower.address);
  });

  it.each([
    ['borrow', buildBorrowTx],
    ['repay', buildRepayTx],
  ] as const)('accepts a %s with a leading SetComputeUnitLimit(60_000)', async (kind, build) => {
    const r = await w.check((await build({ ...w.opts, computeUnits: 60_000 })).wire);
    expect(r.ok && r.value.kind).toBe(kind);
  });

  it('accepts a compute-unit limit of exactly MAX_COMPUTE_UNITS', async () => {
    expect(MAX_COMPUTE_UNITS).toBe(200_000);
    const r = await w.check(
      (await buildBorrowTx({ ...w.opts, computeUnits: MAX_COMPUTE_UNITS })).wire,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts any enclave_entry address on borrow (the program checks it)', async () => {
    const { ata, borrow } = await borrowParts(w.opts);
    const r = await w.check(await w.tx([ata, withAddress(borrow, 8, w.other.address)]));
    expect(r.ok).toBe(true);
  });

  it('accepts the shape check for a forged borrower signature (rule 11 is separate)', async () => {
    const { ata, borrow } = await borrowParts(w.opts);
    const forged = (
      await buildTx({
        feePayer: w.relayer.address,
        instructions: [ata, borrow],
        signers: [w.borrower],
        forged: [w.borrower.address],
      })
    ).wire;
    const r = await w.check(forged);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await verifyBorrowerSignature(r.value)).toBe(false);
  });
});

describe('verifyBorrowerSignature (rule 11)', () => {
  it('is true for the borrower signature over the message bytes', async () => {
    const r = await w.check((await buildBorrowTx(w.opts)).wire);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await verifyBorrowerSignature(r.value)).toBe(true);
  });
});

describe('checkLoanTx: rule 1 (version 0, decodable)', () => {
  it.each(GARBAGE)('rejects %s as rule 1 without throwing', async (_name, bytes) => {
    expect(rejectedRule(await w.check(bytes))).toBe(1);
  });

  it('rejects a legacy message', async () => {
    const { ata, borrow } = await borrowParts(w.opts);
    expect(rejectedRule(await w.check(await w.tx([ata, borrow], { version: 'legacy' })))).toBe(1);
  });

  it('rejects a valid tx with trailing junk bytes as rule 1', async () => {
    const wire = (await buildBorrowTx(w.opts)).wire;
    const padded = new Uint8Array(wire.length + 3);
    padded.set(wire);
    expect(rejectedRule(await w.check(wire))).toBe('accepted');
    expect(rejectedRule(await w.check(padded))).toBe(1);
  });

  it('rejects a program index past the static accounts as rule 1 (never a throw)', async () => {
    const wire = (await buildBorrowTx(w.opts)).wire;
    const bad = reencoded(wire, ([first]) => {
      if (first !== undefined) first.programAddressIndex = 200;
    });
    expect(rejectedRule(await w.check(bad))).toBe(1);
  });

  it('rejects an account index past the static accounts (a hole in enclave_entry) as rule 1', async () => {
    const wire = (await buildBorrowTx(w.opts)).wire;
    const bad = reencoded(wire, ([, borrow]) => {
      if (borrow?.accountIndices !== undefined) borrow.accountIndices[8] = 200;
    });
    expect(rejectedRule(await w.check(bad))).toBe(1);
  });
});

type Row = [name: string, rule: number, build: () => Promise<Uint8Array>];

const parts = () => borrowParts(w.opts);
const repayIx = async () => (await repayParts(w.opts)).repay;
const noopIx = (): Instruction => ({
  programAddress: SYSTEM_PROGRAM,
  data: new Uint8Array([1, 2, 3, 4]),
});
const flipFirstByte = (data: ReadonlyUint8Array | undefined): Uint8Array => {
  const copy = new Uint8Array(data ?? []);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
};
const resized = (data: ReadonlyUint8Array | undefined, delta: number): Uint8Array => {
  const src = data ?? new Uint8Array();
  const out = new Uint8Array(src.length + delta);
  out.set(src.subarray(0, out.length));
  return out;
};
const borrowWith = async (edit: (ix: Instruction) => Instruction) => {
  const { ata, borrow } = await parts();
  return w.tx([ata, edit(borrow)]);
};
const ataWith = async (edit: (ix: Instruction) => Instruction) => {
  const { ata, borrow } = await parts();
  return w.tx([edit(ata), borrow]);
};
const repayWith = async (edit: (ix: Instruction) => Instruction) => w.tx([edit(await repayIx())]);

const ROWS: Row[] = [
  // Rule 2: no address lookup tables.
  [
    'lookup table present',
    2,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([ata, borrow], { lookupTable: true });
    },
  ],

  // Rule 3: exactly two signers, fee payer = relayer, second = borrower != relayer.
  [
    'three signers',
    3,
    async () => {
      const extra = await generateKeyPairSigner();
      const { ata, borrow } = await parts();
      const signing = withAccount(borrow, 8, {
        address: extra.address,
        role: AccountRole.READONLY_SIGNER,
      });
      return w.tx([ata, signing], { signers: [w.borrower, extra] });
    },
  ],
  [
    'fee payer is not the relayer',
    3,
    async () =>
      w.tx([await repayIx()], { feePayer: w.other.address, signers: [w.other, w.borrower] }),
  ],
  [
    'borrower is the relayer',
    3,
    async () => {
      const same: LoanOpts = { ...w.opts, borrower: w.relayer };
      const { repay } = await repayParts(same);
      return (
        await buildTx({ feePayer: w.relayer.address, instructions: [repay], signers: [w.relayer] })
      ).wire;
    },
  ],

  // Rule 4: relayer slot empty, borrower slot a 64-byte signature.
  [
    'relayer signature already present',
    4,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([ata, borrow], { signers: [w.relayer, w.borrower] });
    },
  ],
  [
    'borrower signature missing',
    4,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([ata, borrow], { signers: [] });
    },
  ],

  // Rule 5: optional leading SetComputeUnitLimit <= 200_000, nothing else from ComputeBudget.
  [
    'SetComputeUnitPrice',
    5,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([computeUnitPrice(1n), ata, borrow]);
    },
  ],
  [
    'compute-unit limit above the cap',
    5,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([computeUnitLimit(MAX_COMPUTE_UNITS + 1), ata, borrow]);
    },
  ],
  [
    'two compute-unit limits',
    5,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([computeUnitLimit(1), computeUnitLimit(1), ata, borrow]);
    },
  ],
  [
    'limit then price',
    5,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([computeUnitLimit(60_000), computeUnitPrice(1n), ata, borrow]);
    },
  ],
  [
    'compute-unit limit with 6 data bytes',
    5,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([
        withData(computeUnitLimit(60_000), new Uint8Array([2, 96, 234, 0, 0, 0])),
        ata,
        borrow,
      ]);
    },
  ],
  [
    'a 5-byte ComputeBudget instruction with another tag (SetLoadedAccountsDataSizeLimit 60 000)',
    5,
    async () => {
      const { ata, borrow } = await parts();
      // Same u32 as a 60 000 CU limit, so only the tag check can reject it.
      return w.tx([
        withData(computeUnitLimit(60_000), new Uint8Array([4, 0x60, 0xea, 0, 0])),
        ata,
        borrow,
      ]);
    },
  ],
  [
    'a compute-unit limit that names the relayer as an account',
    5,
    async () => {
      const { ata, borrow } = await parts();
      const named: Instruction = {
        ...computeUnitLimit(60_000),
        accounts: [{ address: w.relayer.address, role: AccountRole.WRITABLE_SIGNER }],
      };
      return w.tx([named, ata, borrow]);
    },
  ],

  // Rule 6: body is exactly [ata, borrow] or [repay].
  [
    'extra instruction after borrow',
    6,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([ata, borrow, noopIx()]);
    },
  ],
  ['extra instruction after repay', 6, async () => w.tx([await repayIx(), noopIx()])],
  ['borrow without the ATA instruction', 6, async () => w.tx([(await parts()).borrow])],
  // With no borrower signer in the message these are one-signer transactions: rule 3, not 6.
  ['ATA instruction alone (one signer)', 3, async () => w.tx([(await parts()).ata])],
  [
    'borrow before the ATA instruction',
    6,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([borrow, ata]);
    },
  ],
  ['ATA followed by repay', 6, async () => w.tx([(await parts()).ata, await repayIx()])],
  [
    'two repays',
    6,
    async () => {
      const repay = await repayIx();
      return w.tx([repay, repay]);
    },
  ],
  ['no instructions (one signer)', 3, async () => w.tx([])],
  [
    'borrow with a wrong discriminator',
    6,
    () => borrowWith((ix) => withData(ix, flipFirstByte(ix.data))),
  ],
  ['borrow data one byte too long', 6, () => borrowWith((ix) => withData(ix, resized(ix.data, 1)))],
  [
    'borrow data one byte too short',
    6,
    () => borrowWith((ix) => withData(ix, resized(ix.data, -1))),
  ],
  [
    'borrow under another program id',
    6,
    () => borrowWith((ix) => withProgram(ix, TOKEN_PROGRAM_ADDRESS)),
  ],
  [
    'repay with a wrong discriminator',
    6,
    () => repayWith((ix) => withData(ix, flipFirstByte(ix.data))),
  ],
  ['repay data one byte too long', 6, () => repayWith((ix) => withData(ix, resized(ix.data, 1)))],
  [
    'repay under another program id',
    6,
    () => repayWith((ix) => withProgram(ix, TOKEN_PROGRAM_ADDRESS)),
  ],

  // Rule 7: createAssociatedTokenIdempotent.
  [
    'ATA payer is not the relayer',
    7,
    () =>
      ataWith((ix) => withAccount(ix, 0, { address: w.other.address, role: AccountRole.WRITABLE })),
  ],
  [
    'ATA address is not the borrower ATA',
    7,
    () => ataWith((ix) => withAddress(ix, 1, w.other.address)),
  ],
  ['ATA owner is not the borrower', 7, () => ataWith((ix) => withAddress(ix, 2, w.other.address))],
  [
    'ATA mint is not the deployment mint',
    7,
    () => ataWith((ix) => withAddress(ix, 3, w.other.address)),
  ],
  ['ATA system program is wrong', 7, () => ataWith((ix) => withAddress(ix, 4, w.other.address))],
  [
    'ATA token program is wrong',
    7,
    () => ataWith((ix) => withAddress(ix, 5, ASSOCIATED_TOKEN_PROGRAM_ADDRESS)),
  ],
  [
    'ATA with 7 accounts',
    7,
    () => ataWith((ix) => withExtraAccount(ix, readonly(w.other.address))),
  ],
  ['ATA with 5 accounts', 7, () => ataWith(withoutLastAccount)],
  [
    'ATA data is Create (empty), not CreateIdempotent',
    7,
    () => ataWith((ix) => withData(ix, new Uint8Array())),
  ],
  ['ATA data is [0]', 7, () => ataWith((ix) => withData(ix, new Uint8Array([0])))],

  // Rule 8: borrow.
  [
    'borrow amount 0',
    8,
    async () => {
      const zero = await borrowParts({ ...w.opts, amount: 0n });
      return w.tx([zero.ata, zero.borrow]);
    },
  ],
  [
    'borrow payer is not the relayer',
    8,
    () =>
      borrowWith((ix) =>
        withAccount(ix, 0, { address: w.other.address, role: AccountRole.WRITABLE }),
      ),
  ],
  [
    'borrow pool not in the deployment',
    8,
    async () => {
      const stranger = await borrowParts({ ...w.opts, pool: w.other.address });
      return w.tx([stranger.ata, stranger.borrow]);
    },
  ],
  [
    'borrow mint is not the deployment mint',
    8,
    () => borrowWith((ix) => withAddress(ix, 3, w.other.address)),
  ],
  [
    'borrow vault is not the pool vault PDA',
    8,
    () => borrowWith((ix) => withAddress(ix, 4, w.other.address)),
  ],
  [
    'borrow token account is not the borrower ATA',
    8,
    () => borrowWith((ix) => withAddress(ix, 5, w.other.address)),
  ],
  [
    'borrow loan is not the loan PDA',
    8,
    () => borrowWith((ix) => withAddress(ix, 6, w.other.address)),
  ],
  [
    'borrow attestation is not the borrower attestation PDA',
    8,
    () => borrowWith((ix) => withAddress(ix, 7, w.other.address)),
  ],
  [
    'borrow token program is wrong',
    8,
    () => borrowWith((ix) => withAddress(ix, 9, ASSOCIATED_TOKEN_PROGRAM_ADDRESS)),
  ],
  [
    'borrow system program is wrong',
    8,
    () => borrowWith((ix) => withAddress(ix, 10, TOKEN_PROGRAM_ADDRESS)),
  ],
  [
    'borrow with 12 accounts',
    8,
    () => borrowWith((ix) => withExtraAccount(ix, readonly(w.other.address))),
  ],
  ['borrow with 10 accounts', 8, () => borrowWith(withoutLastAccount)],
  [
    'borrow borrower slot holds another account (the borrower signs from enclave_entry)',
    8,
    () =>
      borrowWith((ix) =>
        withAccount(
          withAccount(ix, 8, { address: w.borrower.address, role: AccountRole.READONLY_SIGNER }),
          1,
          readonly(w.other.address),
        ),
      ),
  ],

  // Rule 9: repay.
  [
    'repay rent_payer is not the relayer',
    9,
    () =>
      repayWith((ix) =>
        withAccount(ix, 6, { address: w.other.address, role: AccountRole.WRITABLE }),
      ),
  ],
  [
    'repay pool not in the deployment',
    9,
    async () => {
      const stranger = await repayParts({ ...w.opts, pool: w.other.address });
      return w.tx([stranger.repay]);
    },
  ],
  [
    'repay mint is not the deployment mint',
    9,
    () => repayWith((ix) => withAddress(ix, 2, w.other.address)),
  ],
  [
    'repay vault is not the pool vault PDA',
    9,
    () => repayWith((ix) => withAddress(ix, 3, w.other.address)),
  ],
  [
    'repay token account is not the borrower ATA',
    9,
    () => repayWith((ix) => withAddress(ix, 4, w.other.address)),
  ],
  [
    'repay loan is not the loan PDA',
    9,
    () => repayWith((ix) => withAddress(ix, 5, w.other.address)),
  ],
  [
    'repay token program is wrong',
    9,
    () => repayWith((ix) => withAddress(ix, 7, ASSOCIATED_TOKEN_PROGRAM_ADDRESS)),
  ],
  [
    'repay with 9 accounts',
    9,
    () => repayWith((ix) => withExtraAccount(ix, readonly(w.other.address))),
  ],
  ['repay with 7 accounts', 9, () => repayWith(withoutLastAccount)],

  // Rule 10: the relayer only as fee payer, ATA payer, borrow payer, repay rent_payer.
  [
    'relayer as the borrow enclave_entry',
    10,
    async () => {
      const { ata, borrow } = await parts();
      return w.tx([ata, withAddress(borrow, 8, w.relayer.address)]);
    },
  ],
];

describe('checkLoanTx: one fixture per rule rejects with exactly that rule', () => {
  it('has a row for every rule 2..10', () => {
    expect(new Set(ROWS.map(([, rule]) => rule))).toEqual(new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]));
  });

  it.each(ROWS)('rejects: %s (rule %d)', async (_name, rule, build) => {
    expect(rejectedRule(await w.check(await build()))).toBe(rule);
  });

  it('rejects the relayer used as the pool (rule 10, all other rules satisfied)', async () => {
    const deployment = testDeployment({ pools: [w.relayer.address] });
    const opts: LoanOpts = { ...w.opts, deployment, pool: w.relayer.address };
    const borrow = await buildBorrowTx(opts);
    const repay = await buildRepayTx(opts);
    expect([
      rejectedRule(await checkLoanTx(borrow.wire, w.relayer.address, deployment)),
      rejectedRule(await checkLoanTx(repay.wire, w.relayer.address, deployment)),
    ]).toEqual([10, 10]);
  });

  it('rejects the relayer used as the mint on repay (rule 10)', async () => {
    const deployment = testDeployment({ mint: w.relayer.address });
    const repay = await buildRepayTx({ ...w.opts, deployment });
    expect(rejectedRule(await checkLoanTx(repay.wire, w.relayer.address, deployment))).toBe(10);
  });

  it('baseline: the same deployment without the relayer in those slots is accepted', async () => {
    expect(MINT).not.toBe(w.relayer.address);
    expect(rejectedRule(await w.check((await buildRepayTx(w.opts)).wire))).toBe('accepted');
  });
});

describe('checkLoanTx: check order (the lower rule is reported when two are broken)', () => {
  const pairs: [name: string, expected: number, build: () => Promise<Uint8Array>][] = [
    [
      'lookup table + a third signer',
      2,
      async () => {
        const extra = await generateKeyPairSigner();
        const { ata, borrow } = await parts();
        const signing = withAccount(borrow, 8, {
          address: extra.address,
          role: AccountRole.READONLY_SIGNER,
        });
        return w.tx([ata, signing], { lookupTable: true, signers: [w.borrower, extra] });
      },
    ],
    [
      'a third signer + relayer signature present',
      3,
      async () => {
        const extra = await generateKeyPairSigner();
        const { ata, borrow } = await parts();
        const signing = withAccount(borrow, 8, {
          address: extra.address,
          role: AccountRole.READONLY_SIGNER,
        });
        return w.tx([ata, signing], { signers: [w.relayer, w.borrower, extra] });
      },
    ],
    [
      'relayer signature present + SetComputeUnitPrice',
      4,
      async () => {
        const { ata, borrow } = await parts();
        return w.tx([computeUnitPrice(1n), ata, borrow], { signers: [w.relayer, w.borrower] });
      },
    ],
    [
      'SetComputeUnitPrice + extra instruction',
      5,
      async () => {
        const { ata, borrow } = await parts();
        return w.tx([computeUnitPrice(1n), ata, borrow, noopIx()]);
      },
    ],
    [
      'extra instruction + bad ATA payer',
      6,
      async () => {
        const { ata, borrow } = await parts();
        const bad = withAccount(ata, 0, { address: w.other.address, role: AccountRole.WRITABLE });
        return w.tx([bad, borrow, noopIx()]);
      },
    ],
    [
      'bad ATA owner + borrow amount 0',
      7,
      async () => {
        const zero = await borrowParts({ ...w.opts, amount: 0n });
        return w.tx([withAddress(zero.ata, 2, w.other.address), zero.borrow]);
      },
    ],
    [
      'borrow amount 0 + relayer as enclave_entry',
      8,
      async () => {
        const zero = await borrowParts({ ...w.opts, amount: 0n });
        return w.tx([zero.ata, withAddress(zero.borrow, 8, w.relayer.address)]);
      },
    ],
  ];

  it.each(pairs)('%s -> rule %d', async (_name, expected, build) => {
    expect(rejectedRule(await w.check(await build()))).toBe(expected);
  });

  it('rent_payer not the relayer + relayer as the pool -> rule 9', async () => {
    const deployment = testDeployment({ pools: [w.relayer.address] });
    const { repay } = await repayParts({ ...w.opts, deployment, pool: w.relayer.address });
    const wire = await w.tx([
      withAccount(repay, 6, { address: w.other.address, role: AccountRole.WRITABLE }),
    ]);
    expect(rejectedRule(await checkLoanTx(wire, w.relayer.address, deployment))).toBe(9);
  });
});

describe('simulationDetail', () => {
  const rows: [string, unknown, unknown][] = [
    [
      'a custom program error',
      { InstructionError: [1, { Custom: 6008 }] },
      { index: 1, custom: 6008 },
    ],
    [
      'a custom error at index 0',
      { InstructionError: [0, { Custom: 0 }] },
      { index: 0, custom: 0 },
    ],
    [
      'a named instruction error',
      { InstructionError: [0, 'InvalidAccountData'] },
      { index: 0, kind: 'InvalidAccountData' },
    ],
    ['a string error', 'BlockhashNotFound', { kind: 'BlockhashNotFound' }],
    ['a string error with a hostile shape', 'x'.repeat(41), { kind: 'unknown' }],
    ['a string error with digits', 'Err0r', { kind: 'unknown' }],
    ['an empty string', '', { kind: 'unknown' }],
    [
      'a named instruction error with a hostile name',
      { InstructionError: [2, 'bad name!'] },
      { index: 2, kind: 'unknown' },
    ],
    ['an unknown object', { foo: 1 }, { kind: 'unknown' }],
    ['null', null, { kind: 'unknown' }],
    ['a number', 7, { kind: 'unknown' }],
    [
      'an InstructionError with a non-numeric index',
      { InstructionError: ['1', 'Foo'] },
      { kind: 'unknown' },
    ],
    ['an InstructionError that is too short', { InstructionError: [1] }, { kind: 'unknown' }],
  ];

  it.each(rows)('maps %s', (_name, err, expected) => {
    expect(simulationDetail(err)).toEqual(expected);
  });
});
