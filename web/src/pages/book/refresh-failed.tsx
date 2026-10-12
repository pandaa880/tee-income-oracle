import { useId } from 'react';
import { Button } from '@tio/ui/button';
import { messageFor } from '../../domain/errors.ts';
import { formatUnixDateTime } from '../../domain/format.ts';
import type { AppError } from '../../domain/types.ts';

export type RefreshFailedProps = {
  error: AppError;
  /** When the book on screen was read (ms since the epoch, TanStack's `dataUpdatedAt`). */
  readAt: number;
  onRetry: () => void;
};

/**
 * A re-read failed while an older book stays on screen. Its badges were judged at that read, so
 * a credential that expired since would still say "fresh": the warning says when it was read.
 */
export function RefreshFailed({ error, readAt, onRetry }: RefreshFailedProps) {
  const titleId = useId();
  const readAtText = formatUnixDateTime(BigInt(Math.floor(readAt / 1000)));
  return (
    <div
      role="status"
      aria-labelledby={titleId}
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-tone-caution bg-tone-caution/10 px-5 py-3 text-sm"
    >
      <p>
        <strong id={titleId}>Couldn’t refresh the book</strong>
        {` (${messageFor(error).title}). Showing the last read, from ${readAtText}; badges were judged then.`}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
