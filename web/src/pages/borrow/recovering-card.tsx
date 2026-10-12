import { Button } from '@tio/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tio/ui/card';

export type RecoveringCardProps = { onRestart: () => void };

/** The stream dropped; the enclave may still finish, so the page polls the attestation on chain. */
export function RecoveringCard({ onRestart }: RecoveringCardProps) {
  return (
    <Card role="status" className="max-w-xl border-tone-caution">
      <CardHeader>
        <CardTitle>Connection lost — checking the chain…</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4">
        <p className="text-sm text-muted-foreground">
          The enclave keeps working even if this page disconnects. We’re looking for your
          attestation on Solana and will show it the moment it lands.
        </p>
        <Button variant="outline" onClick={onRestart}>
          Start again
        </Button>
      </CardContent>
    </Card>
  );
}
