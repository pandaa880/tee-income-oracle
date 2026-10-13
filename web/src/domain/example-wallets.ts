// Devnet borrowers a reader can verify without running the borrow flow first. Public test
// wallets from our own runs (no real person). The labels say who they are, never the verdict:
// that comes from the live check (a rebuilt enclave retires build #1 and flips its wallets to
// FAIL). A retired build is the one permanent fact: a revoked entry never comes back.
import { type Address, address } from '@solana/kit';

export type ExampleWallet = {
  wallet: Address;
  /** Who this is, in the page's words. */
  label: string;
  /** The build is revoked, so its wallets always fail "Entry is active": the FAIL example. */
  retired: boolean;
};

const DEVNET: readonly ExampleWallet[] = [
  {
    wallet: address('8Z6Fa1j6WChXyAgxu6bCyPPUVi9mnuPgWTxM7W8cngAp'),
    label: 'Tier A borrower on build #1',
    retired: false,
  },
  {
    wallet: address('CESaURSipHKZzVA92vQ55bGaXhbgUZhQ5E3QTmyHmfWy'),
    label: 'Tier C borrower on build #1',
    retired: false,
  },
  {
    wallet: address('9BhCFK5bmPCswYp13r84tBduvZzeEuRa9Wh4kCy9LpPS'),
    label: 'Tier A borrower on build #0, retired (fails)',
    retired: true,
  },
];

const BY_CLUSTER = new Map<string, readonly ExampleWallet[]>([['devnet', DEVNET]]);

/** The example borrowers of `cluster`; empty for a cluster we have none for. */
export function exampleWallets(cluster: string): readonly ExampleWallet[] {
  return BY_CLUSTER.get(cluster) ?? [];
}
