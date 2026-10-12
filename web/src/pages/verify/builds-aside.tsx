import { Button } from '@tio/ui/button';
import { Skeleton } from '@tio/ui/skeleton';
import { StatusBadge } from '@tio/ui/status-badge';
import { useBuilds } from '../../app/use-builds.ts';
import { type BuildRow, type BuildStatus, buildTone } from '../../domain/builds.ts';
import { messageFor } from '../../domain/errors.ts';
import { formatUnixDateTime, shortEthAddress } from '../../domain/format.ts';
import type { AppError } from '../../domain/types.ts';

const STATUS_LABEL: Record<BuildStatus, string> = {
  active: 'ACTIVE',
  revoked: 'REVOKED',
  unknown: 'NOT ON CHAIN',
};

function when(row: BuildRow): string {
  if (row.revokedAt !== null) return `revoked ${formatUnixDateTime(row.revokedAt)}`;
  if (row.registeredAt !== null) return `registered ${formatUnixDateTime(row.registeredAt)}`;
  return 'no registry entry read';
}

function Row({ row }: { row: BuildRow }) {
  const active = row.status === 'active';
  return (
    <li
      className={`flex flex-col gap-1 rounded-md border p-4 ${active ? 'border-2 border-tone-positive bg-tone-positive/10' : 'border-border bg-card'}`}
    >
      <span className="flex items-center justify-between gap-3">
        <strong>{`#${row.id}`}</strong>
        <StatusBadge tone={buildTone(row.status)} label={STATUS_LABEL[row.status]} />
      </span>
      <span className="font-mono text-xs text-muted-foreground">
        {`attester ${shortEthAddress(row.attester)}`}
      </span>
      <span className="text-xs text-muted-foreground">{when(row)}</span>
    </li>
  );
}

function Failed({ error, onRetry }: { error: AppError; onRetry: () => void }) {
  const { title } = messageFor(error);
  return (
    <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
      <span>{`${title}: the registry could not be read.`}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Read again
      </Button>
    </div>
  );
}

/** "Who signed it": every build the deployment lists, with its registry state. Needs no wallet. */
export function BuildsAside() {
  const builds = useBuilds();
  return (
    <aside aria-label="Enclave builds" className="flex min-w-0 flex-[1_1_17rem] flex-col gap-2.5">
      <span className="text-sm text-muted-foreground">
        Who signed it: registered enclave builds
      </span>
      {builds.data === undefined && builds.error === null && (
        <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Reading the registry">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {builds.data === undefined && builds.error !== null && (
        <Failed error={builds.error} onRetry={() => void builds.refetch()} />
      )}
      {builds.data !== undefined && (
        <ol className="flex flex-col gap-2.5">
          {builds.data.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </ol>
      )}
    </aside>
  );
}
