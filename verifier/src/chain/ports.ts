/**
 * The one thing the verifier needs from Solana: raw accounts by address. A port,
 * so the library runs over a kit RPC (`kit.ts`), a browser's fetch, or a fake in
 * tests, and never trusts more than the bytes it decodes itself.
 */
import type { Address } from '@solana/kit';

export type RawAccount = { owner: Address; data: Uint8Array };

export type ChainReader = {
  /** The account at `address`, or null if there is none. */
  account(address: Address): Promise<RawAccount | null>;
};
