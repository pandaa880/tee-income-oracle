import type { Address } from '@solana/kit';
import { StatusBadge } from '@tio/ui/status-badge';
import type { CheckRow, VerifyView } from '../../domain/verify-view.ts';
import { ExternalLink } from '../layout/external-link.tsx';

export type ChecksCardProps = { view: VerifyView; wallet: Address };

function Mark({ status }: { status: CheckRow['status'] }) {
  const pass = status === 'pass';
  return (
    <span
      role="img"
      aria-label={status}
      className={`inline-flex size-6.5 shrink-0 items-center justify-center rounded-sm text-sm font-bold ${pass ? 'bg-tone-positive text-primary-foreground' : 'bg-tone-negative text-primary-foreground'}`}
    >
      {pass ? '✓' : '✕'}
    </span>
  );
}

function Check({ row }: { row: CheckRow }) {
  return (
    <li className="flex gap-3.5 border-b border-border py-3.5 last:border-b-0">
      <Mark status={row.status} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <strong className="font-semibold">{row.title}</strong>
        <span className="text-sm text-muted-foreground">{row.explanation}</span>
        <span className="font-mono text-xs break-all text-muted-foreground">{row.detail}</span>
      </span>
    </li>
  );
}

/** The seven checks and the verdict, with where each input came from. */
export function ChecksCard({ view, wallet }: ChecksCardProps) {
  const { links } = view;
  const command = `pnpm --filter @tio/verifier verify -- ${wallet} --cluster devnet`;
  return (
    <section
      aria-label="Checks"
      className="flex min-w-0 flex-[999_1_34rem] flex-col gap-4 rounded-md border border-border bg-card p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-2xl leading-tight font-medium">{view.headline}</h2>
        <StatusBadge tone={view.verdictTone} label={view.verdict} />
      </div>
      {view.verdictNote !== null && (
        <p className="text-sm text-tone-negative">{view.verdictNote}</p>
      )}
      <ol className="flex flex-col">
        {view.checks.map((row) => (
          <Check key={row.id} row={row} />
        ))}
      </ol>
      <div className="flex flex-wrap gap-4 text-sm">
        {links.release !== null && (
          <ExternalLink href={links.release}>
            {`Enclave source: release ${links.releaseTag ?? ''}`}
          </ExternalLink>
        )}
        {links.archive !== null && (
          <ExternalLink href={links.archive}>Archived attestation</ExternalLink>
        )}
        <ExternalLink href={links.entry}>Registry entry</ExternalLink>
      </div>
      <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted p-4">
        <span className="text-sm text-muted-foreground">Prefer a terminal? Same library:</span>
        <code className="font-mono text-sm break-all">{command}</code>
      </div>
      <p className="text-sm text-muted-foreground">
        Why an archived document: the enclave serves it over plain HTTP, which browsers block on an
        HTTPS page. The document is signed by AWS, so it doesn’t matter who carries it, and its hash
        is pinned on chain.
      </p>
    </section>
  );
}
