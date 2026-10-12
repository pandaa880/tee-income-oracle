import type { Address } from '@solana/kit';
import { type Deps, realDeps } from './deps.ts';

/** The borrower's wallet: the tab's demo keypair, restored once by `initDeps`. */
export function useWallet(deps: Deps = realDeps()): { address: Address } {
  return { address: deps.signer.address };
}
