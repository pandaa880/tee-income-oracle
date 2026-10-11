import { Badge } from '@tio/ui/badge';
import { Button } from '@tio/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tio/ui/card';
import { type ErrorAction, messageFor } from '../../domain/errors.ts';
import type { AppError } from '../../domain/types.ts';

export type ErrorCardProps = {
  error: AppError;
  onRestart: () => void;
  onRetry: () => void;
  onReattest: () => void;
  /** Used when the error offers no action of its own, so a card is never a dead end. */
  fallback?: Exclude<ErrorAction, 'none'>;
};

/** The code chip stays visible for support (FORMATS §16 codes, relay rules, program errors). */
function codeChip(error: AppError): string {
  if (error.code === 'bad_transaction') return `${error.code} · rule ${error.rule}`;
  if (error.code === 'simulation_failed' && error.custom !== undefined) {
    return `${error.code} · ${error.custom}`;
  }
  return error.code;
}

const ACTION_LABEL: Record<Exclude<ErrorAction, 'none'>, string> = {
  retry: 'Try again',
  restart: 'Start again',
  reattest: 'Re-attest',
};

/** One expected failure, inline where it happened, with the one thing the borrower can do. */
export function ErrorCard({ error, onRestart, onRetry, onReattest, fallback }: ErrorCardProps) {
  const { title, detail, action: own } = messageFor(error);
  const action = own === 'none' ? (fallback ?? 'none') : own;
  const handlers: Record<Exclude<ErrorAction, 'none'>, () => void> = {
    retry: onRetry,
    restart: onRestart,
    reattest: onReattest,
  };
  return (
    <Card role="alert" className="max-w-xl border-tone-negative">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <CardTitle>{title}</CardTitle>
        <Badge variant="outline" tone="negative">
          {codeChip(error)}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4">
        <p className="text-sm text-muted-foreground">{detail}</p>
        {action !== 'none' && (
          <Button variant="outline" onClick={handlers[action]}>
            {ACTION_LABEL[action]}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
