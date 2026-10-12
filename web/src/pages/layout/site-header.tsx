import { Link, useRouterState } from '@tanstack/react-router';
import { Badge } from '@tio/ui/badge';
import { ThemeToggle } from '@tio/ui/theme-toggle';
import { useConfig } from '../../app/use-config.ts';
import { WalletChip } from './wallet-chip.tsx';

const NAV_LINK = 'inline-flex min-h-10 items-center text-sm underline-offset-4 hover:underline';

/** Brand, nav (gated items appear with their PR), network badge, wallet chip on the flow pages. */
export function SiteHeader() {
  const { features } = useConfig();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showWallet = pathname.startsWith('/borrow') || pathname.startsWith('/loan');
  return (
    <header className="mx-auto flex max-w-(--content-max) flex-wrap items-center gap-x-6 gap-y-3 px-4 pt-6">
      <Link to="/" className="inline-flex min-h-10 items-center font-display text-lg leading-none">
        TEE Income Oracle
      </Link>
      <nav aria-label="Main" className="flex items-center gap-4">
        <Link to="/borrow" className={NAV_LINK}>
          Borrow
        </Link>
        {features.book && (
          <Link to="/book" search={{ pool: 0 }} className={NAV_LINK}>
            Loan book
          </Link>
        )}
        {features.verify && (
          <a href="/verify" className={NAV_LINK}>
            Verify
          </a>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-4">
        {showWallet && <WalletChip />}
        <Badge variant="outline">DEVNET</Badge>
        <ThemeToggle />
      </div>
    </header>
  );
}
