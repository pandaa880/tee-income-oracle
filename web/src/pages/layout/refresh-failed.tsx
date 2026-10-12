import { useId } from 'react';
import { Button } from '@tio/ui/button';
import { messageFor } from '../../domain/errors.ts';
import { formatUnixDateTime } from '../../domain/format.ts';
import type { AppError } from '../../domain/types.ts';

export type RefreshFailedProps = {
  /** "Couldn’t refresh the book", "Couldn’t re-check this wallet". */
  title: string;
  /** What the time on screen means: "badges were judged then", "the checks ran then". */
  note: string;
  error: AppError;
  /** When the result on screen was read (ms since the epoch, TanStack's `dataUpdatedAt`). */
  readAt: number;
  onRetry: () => void;
};

/**
 * A re-read failed while an older result stays on screen. That result was judged at its read, so
 * anything that changed since (an expiry, a revocation) is not in it: the warning says when.
 */
export function RefreshFailed({ title, note, error, readAt, onRetry }: RefreshFailedProps) {
  const titleId = useId();
  const readAtText = formatUnixDateTime(BigInt(Math.floor(readAt / 1000)));
  return (
    <div
      role="status"
      aria-labelledby={titleId}
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-tone-caution bg-tone-caution/10 px-5 py-3 text-sm"
    >
      <p>
        <strong id={titleId}>{title}</strong>
        {` (${messageFor(error).title}). Showing the last read, from ${readAtText}; ${note}.`}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
