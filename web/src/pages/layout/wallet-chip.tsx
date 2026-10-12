import { useEffect, useState } from 'react';
import { useWallet } from '../../app/use-wallet.ts';
import { shortAddress } from '../../domain/format.ts';

type CopyState = 'idle' | 'copied' | 'failed';

/** The chip's second line: where the wallet came from, or how the last copy went. */
const NOTE: Record<CopyState, string> = {
  idle: 'Made in this tab',
  copied: 'Address copied',
  failed: 'Couldn’t copy',
};

/** How long the copy result shows before the line goes back to "Made in this tab". */
const NOTE_MS = 1500;

/** Two overlapping sheets, the copy cue. Decorative: the chip's text and title name the action. */
function CopyIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="8" y="8" width="13" height="13" rx="1.5" />
      <path d="M16 8V4.5A1.5 1.5 0 0 0 14.5 3h-10A1.5 1.5 0 0 0 3 4.5v10A1.5 1.5 0 0 0 4.5 16H8" />
    </svg>
  );
}

/**
 * The tab's demo wallet, labelled as such: made here, gone with the tab (the header's DEVNET badge
 * names the network). Clicking copies the full address, which the label only shows shortened.
 */
export function WalletChip() {
  const { address } = useWallet();
  const [copy, setCopy] = useState<CopyState>('idle');

  useEffect(() => {
    if (copy === 'idle') return undefined;
    const timer = setTimeout(() => setCopy('idle'), NOTE_MS);
    return () => clearTimeout(timer);
  }, [copy]);

  async function copyAddress() {
    try {
      // Missing outside a secure context or refused by the browser: both land in catch.
      await navigator.clipboard.writeText(address);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copyAddress()}
      title="Copy the full wallet address"
      className="flex flex-col items-end rounded-sm px-2 py-1 text-right hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="inline-flex items-center gap-1.5 font-mono text-xs tracking-(--tracking-caps) uppercase">
        DEMO WALLET · {shortAddress(address)}
        <CopyIcon />
      </span>
      <span aria-live="polite" className="text-xs text-muted-foreground">
        {NOTE[copy]}
      </span>
    </button>
  );
}
