import { Badge } from '@tio/ui/badge';
import { Button } from '@tio/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tio/ui/card';
import { messageFor } from '../../domain/errors.ts';
import type { AppError } from '../../domain/types.ts';

export type VerifyErrorProps = { error: AppError; onRetry: () => void };

function codeChip(error: AppError): string {
  return error.code === 'verify_failed' ? error.reason : error.code;
}

/**
 * The verifier stopped before a verdict, or the chain could not be read. Every failure with an
 * action of its own gets Retry (there is one flow here, so "start again" is the same read); a
 * message with none (no tier, a stale tab) has the form above to try another wallet.
 */
export function VerifyError({ error, onRetry }: VerifyErrorProps) {
  const { title, detail, action } = messageFor(error);
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
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
