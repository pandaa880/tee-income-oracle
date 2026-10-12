// The public verify page (mockup board 9): paste a wallet, the browser reads Solana and runs the
// verifier's seven checks itself. `?wallet=` holds what was typed, so a result has a URL.
import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { queryKeys } from '../../app/query-keys.ts';
import { useConfig } from '../../app/use-config.ts';
import { parseWalletInput } from '../../domain/verify-view.ts';
import { BuildsAside } from './builds-aside.tsx';
import { VerificationResult } from './verification-result.tsx';
import { WalletForm } from './wallet-form.tsx';

const route = getRouteApi('/verify');

export function VerifyPage() {
  const { wallet: raw } = route.useSearch();
  const { cluster } = useConfig();
  const client = useQueryClient();
  // `?wallet=` with nothing after it is no wallet, not a wrong one.
  const typed = raw === undefined || raw.trim() === '' ? undefined : raw;
  const wallet = typed === undefined ? null : parseWalletInput(typed);
  const invalid = typed !== undefined && wallet === null;

  /** Check again on the same wallet: drop the cached answer so the result mounts a fresh read. */
  const repeat = () => {
    if (wallet !== null) void client.resetQueries({ queryKey: queryKeys.verify(cluster, wallet) });
  };

  return (
    <main className="mx-auto flex max-w-(--content-max) flex-col gap-7 px-4 py-10">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="font-display text-2xl leading-[1.08] font-medium md:text-[2.75rem]">
          Check any tier yourself
        </h1>
        <p className="text-muted-foreground">
          Paste a wallet. This page reads Solana directly from your browser — no API key, no account
          with us, nothing served by our backend. You trust AWS Nitro and the published code;
          everything else is checked below.
        </p>
      </div>
      {/* Keyed on the search param, so a new URL resets what the box shows. */}
      <WalletForm key={typed ?? ''} initial={typed ?? ''} invalid={invalid} onRepeat={repeat} />
      {wallet === null ? (
        <div className="flex flex-wrap items-start gap-6">
          <BuildsAside />
        </div>
      ) : (
        <VerificationResult wallet={wallet} />
      )}
    </main>
  );
}
