import { Link } from '@tanstack/react-router';
import { Button } from '@tio/ui/button';
import type { ExampleWallet } from '../../domain/example-wallets.ts';

export type ExampleChipsProps = { examples: readonly ExampleWallet[] };

/**
 * A one-click wallet for a reader who has none to paste. Renders nothing without examples. The
 * router marks the chip whose wallet is in the URL (`aria-current="page"`, search included).
 */
export function ExampleChips({ examples }: ExampleChipsProps) {
  if (examples.length === 0) return null;
  return (
    <nav aria-label="Example wallets" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="text-sm text-muted-foreground">No wallet handy? Try a devnet borrower:</span>
      {examples.map((example) => (
        <Button key={example.wallet} variant="link" size="sm" asChild>
          <Link
            to="/verify"
            search={{ wallet: example.wallet }}
            activeProps={{ className: 'font-semibold' }}
          >
            {example.label}
          </Link>
        </Button>
      ))}
    </nav>
  );
}
