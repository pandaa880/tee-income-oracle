import { Link, useRouterState } from '@tanstack/react-router';
import { Badge } from '@tio/ui/badge';
import { ThemeToggle } from '@tio/ui/theme-toggle';
import { useConfig } from '../../app/use-config.ts';
import { WalletChip } from './wallet-chip.tsx';

const NAV_LINK =
  'inline-flex min-h-10 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline';

/** The page you're on reads in ink, underlined (mockups: the nav item of the current board). */
const ACTIVE = { className: 'text-foreground underline', 'aria-current': 'page' } as const;

/**
 * Brand, nav (gated items appear with their PR), network badge, wallet chip on the flow pages.
 * A full-width ruled bar, brand · nav · tools spread across the page column (mockup board 1b);
 * the tools stay right-aligned when they wrap onto their own line.
 */
export function SiteHeader() {
  const { features } = useConfig();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showWallet = pathname.startsWith('/borrow') || pathname.startsWith('/loan');
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex min-h-16 max-w-(--content-max) flex-wrap items-center justify-between gap-4 px-4 py-2">
        <Link
          to="/"
          className="inline-flex min-h-10 items-center font-display text-lg leading-none font-semibold sm:text-[1.25rem]"
        >
          TEE Income Oracle
        </Link>
        <nav aria-label="Main" className="flex items-center gap-5">
          <Link to="/borrow" className={NAV_LINK} activeProps={ACTIVE}>
            Borrow
          </Link>
          {features.book && (
            <Link
              to="/book"
              search={{ pool: 0 }}
              className={NAV_LINK}
              activeProps={ACTIVE}
              activeOptions={{ includeSearch: false }}
            >
              Loan book
            </Link>
          )}
          {features.verify && (
            <Link
              to="/verify"
              className={NAV_LINK}
              activeProps={ACTIVE}
              activeOptions={{ includeSearch: false }}
            >
              Verify
            </Link>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {showWallet && <WalletChip />}
          <Badge variant="outline" tone="caution">
            DEVNET
          </Badge>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
