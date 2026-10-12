import { GITHUB_URL, RELEASE } from '../../app/release.ts';
import { ExternalLink } from './external-link.tsx';

export function SiteFooter() {
  return (
    <footer className="mx-auto flex max-w-(--content-max) flex-col gap-2 border-t border-border px-4 py-8 text-sm text-muted-foreground">
      <p>
        Simulated bank, real protocol: a sandbox that speaks India's ReBIT AA spec with demo keys.
        Devnet only. Demo admin is one operator wallet; a multisig with a timelock comes before
        mainnet.
      </p>
      <p className="font-mono text-xs">
        {RELEASE} · <ExternalLink href={GITHUB_URL}>source</ExternalLink>
      </p>
    </footer>
  );
}
