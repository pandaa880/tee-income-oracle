import { Badge } from '@tio/ui/badge';
import { LedgerList, LedgerRow } from '@tio/ui/ledger';
import { TONE_TEXT } from '@tio/ui/tokens';
import { shortHex } from '../../domain/format.ts';
import { tierTone } from '../../domain/tier-tone.ts';

/** The published default policy (sha256 of `test-vectors/policy/default.json`), the demo pools' rules. */
const DEFAULT_POLICY = '81112a23f4ee2835f6459b1f25d9159566204bc2e3e4d318b3ac73d526932e1c';

/**
 * What a tier carries instead of a statement, drawn as a receipt. Every value is an example and
 * labelled so; nothing here is read from chain, so it makes no live claim (no "registered").
 */
export function ExampleReceipt() {
  return (
    <figure
      aria-label="Example receipt"
      className="m-0 flex w-full max-w-sm rotate-[0.6deg] flex-col gap-3 border-x border-y-2 border-x-border border-y-rule-strong border-dashed bg-card p-5 font-mono text-xs motion-reduce:rotate-0"
    >
      <div className="flex items-baseline justify-between gap-3 border-b-3 border-double border-rule-strong pb-2">
        <span className="tracking-(--tracking-caps)">RECEIPT</span>
        <Badge variant="outline" tone="caution">
          EXAMPLE · DEVNET
        </Badge>
      </div>
      <p className="m-0 flex items-baseline gap-3">
        <span className={`font-display text-5xl leading-none ${TONE_TEXT[tierTone('A')]}`}>A</span>
        <span className="text-muted-foreground">tier, passed the lender’s rules</span>
      </p>
      <LedgerList>
        <LedgerRow label="Wallet" value="7xKp…3fQa" mono />
        <LedgerRow label="Policy" value={shortHex(DEFAULT_POLICY)} mono />
        <LedgerRow label="Enclave build" value="#1 · AWS Nitro" mono />
        <LedgerRow label="Data" value="AA-signed" mono />
        <LedgerRow label="Issued" value="09 Oct 2026 · 30 days" mono />
        <LedgerRow label="Bank statement" value="not attached" tone="positive" strong />
      </LedgerList>
      <figcaption className="text-muted-foreground">
        Any program on Solana can read it. Anyone can check it.
      </figcaption>
    </figure>
  );
}
