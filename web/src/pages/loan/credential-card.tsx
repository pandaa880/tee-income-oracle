import { Link } from '@tanstack/react-router';
import { Button } from '@tio/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tio/ui/card';
import { StatusBadge } from '@tio/ui/status-badge';
import {
  credentialAction,
  credentialLabel,
  credentialMessage,
} from '../../domain/credential-copy.ts';
import { credentialTone } from '../../domain/credential-tone.ts';
import type { CredentialStatus } from '../../domain/credential.ts';

export type CredentialCardProps = { status: CredentialStatus };

/** Why this pool won't lend right now, and the one way out when there is one. */
export function CredentialCard({ status }: CredentialCardProps) {
  const { title, detail } = credentialMessage(status);
  const action = credentialAction(status);
  return (
    <Card className="max-w-xl">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <CardTitle>{title}</CardTitle>
        <StatusBadge tone={credentialTone(status)} label={credentialLabel(status)} />
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4">
        <p className="text-sm text-muted-foreground">{detail}</p>
        {action === 'reattest' && (
          <Button asChild>
            <Link to="/borrow">Re-attest</Link>
          </Button>
        )}
        {action === 'get_tier' && (
          <Button asChild>
            <Link to="/borrow">Get a tier</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
