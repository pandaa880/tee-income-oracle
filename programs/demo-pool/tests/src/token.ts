// SPL Token helpers for the pool tests (classic Token program, 6 decimals).
// The mint account is planted with `setAccount` because `@solana-program/system`
// is not a dependency; everything else goes through real instructions.
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintEncoder,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { type Address, type KeyPairSigner, generateKeyPairSigner } from '@solana/kit';
import { type Harness, send } from '@tio/oracle-tests/harness';

export const MINT_DECIMALS = 6;
const MINT_LAMPORTS = 10_000_000;

/** A fresh 6-decimal mint whose mint authority is `mintAuthority`. */
export async function createMint(h: Harness, mintAuthority: Address): Promise<Address> {
  const mint = (await generateKeyPairSigner()).address;
  const data = getMintEncoder().encode({
    mintAuthority,
    supply: 0n,
    decimals: MINT_DECIMALS,
    isInitialized: true,
    freezeAuthority: null,
  });
  h.surfnet.setAccount(mint, MINT_LAMPORTS, new Uint8Array(data), TOKEN_PROGRAM_ADDRESS);
  return mint;
}

export async function ataOf(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

/** Creates (idempotently) the associated token account of `owner` for `mint`. */
export async function createAta(
  h: Harness,
  payer: KeyPairSigner,
  owner: Address,
  mint: Address,
): Promise<Address> {
  const instruction = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer,
    owner,
    mint,
  });
  await send(h, payer, [instruction]);
  return ataOf(owner, mint);
}

export async function mintTo(
  h: Harness,
  mint: Address,
  mintAuthority: KeyPairSigner,
  destination: Address,
  amount: bigint,
): Promise<void> {
  const instruction = getMintToCheckedInstruction({
    mint,
    token: destination,
    mintAuthority,
    amount,
    decimals: MINT_DECIMALS,
  });
  await send(h, h.payer, [instruction]);
}

export async function transferTokens(
  h: Harness,
  owner: KeyPairSigner,
  source: Address,
  mint: Address,
  destination: Address,
  amount: bigint,
): Promise<void> {
  const instruction = getTransferCheckedInstruction({
    source,
    mint,
    destination,
    authority: owner,
    amount,
    decimals: MINT_DECIMALS,
  });
  await send(h, h.payer, [instruction]);
}

export async function tokenBalance(h: Harness, tokenAccount: Address): Promise<bigint> {
  return (await fetchToken(h.rpc, tokenAccount)).data.amount;
}
