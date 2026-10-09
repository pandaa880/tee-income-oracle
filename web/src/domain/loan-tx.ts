// Builds the two loan shapes the gateway's relayer co-signs (FORMATS §16 "Relay"): the relayer
// pays fees and rent, the borrower signs. Pure: no RPC, the blockhash comes in.
import {
  type Address,
  type Blockhash,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';
import { getBorrowInstructionAsync, getRepayInstructionAsync } from '@tio/demo-pool-client';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress } from '@tio/oracle-client/attest';

export type LoanDeployment = { mint: Address; credential: Address; schema: Address };

type Common = {
  relayer: Address;
  borrower: TransactionSigner;
  pool: Address;
  deployment: LoanDeployment;
  blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint };
};

export type BorrowInput = Common & { measurementId: number; amount: bigint };
export type RepayInput = Common;

async function borrowerToken(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata;
}

/**
 * A v0 message paid by the relayer. One noop signer stands for the relayer everywhere (fee payer
 * and payer): kit refuses two different signer objects for one address, and a noop signer leaves
 * the relayer's slot empty for the gateway to fill.
 */
function relayerMessage(relayer: TransactionSigner, input: Common) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(relayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash, m),
  );
}

/** `[CreateAssociatedTokenIdempotent, demo_pool.borrow]`, relayer as fee payer and payer. */
export async function buildBorrowMessage(input: BorrowInput) {
  const relayer = createNoopSigner(input.relayer);
  const { borrower, pool, deployment } = input;
  const ata = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: relayer,
    owner: borrower.address,
    mint: deployment.mint,
  });
  const borrow = await getBorrowInstructionAsync({
    payer: relayer,
    borrower,
    pool,
    mint: deployment.mint,
    borrowerToken: await borrowerToken(borrower.address, deployment.mint),
    attestation: await attestationAddress(
      deployment.credential,
      deployment.schema,
      borrower.address,
    ),
    enclaveEntry: (await findEnclaveEntryPda({ measurementId: input.measurementId }))[0],
    amount: input.amount,
  });
  return appendTransactionMessageInstructions([ata, borrow], relayerMessage(relayer, input));
}

/** `[demo_pool.repay]`; the Loan's rent goes back to the relayer that paid it. */
export async function buildRepayMessage(input: RepayInput) {
  const relayer = createNoopSigner(input.relayer);
  const { borrower, pool, deployment } = input;
  const repay = await getRepayInstructionAsync({
    borrower,
    pool,
    mint: deployment.mint,
    borrowerToken: await borrowerToken(borrower.address, deployment.mint),
    rentPayer: input.relayer,
  });
  return appendTransactionMessageInstructions([repay], relayerMessage(relayer, input));
}

export type LoanMessage =
  | Awaited<ReturnType<typeof buildBorrowMessage>>
  | Awaited<ReturnType<typeof buildRepayMessage>>;

/** Signs with the borrower only and returns standard base64 wire bytes for `/v1/loans/relay`. */
export async function signForRelay(message: LoanMessage): Promise<string> {
  const signed = await partiallySignTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}
