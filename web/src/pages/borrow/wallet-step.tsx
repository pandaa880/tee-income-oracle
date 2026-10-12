import { Badge } from '@tio/ui/badge';
import { Button } from '@tio/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tio/ui/card';

export type WalletStepProps = {
  onStart: () => void;
  /** The service is down: the button is disabled and this says why. */
  disabledReason: string | null;
};

const POINTS = [
  'Signs the consent and the loan for you',
  'No SOL needed: the relayer pays fees',
  'Works on phones too',
];

/** Demo wallet only in this build; an own-wallet option is on the backlog. */
export function WalletStep({ onStart, disabledReason }: WalletStepProps) {
  return (
    <section className="flex flex-col gap-6">
      <h1 className="font-display text-2xl leading-tight">Which wallet should hold the tier?</h1>
      <div className="flex max-w-prose flex-col gap-1 text-muted-foreground">
        <p>The tier is written to a wallet address.</p>
        <p>Network fees are paid by the demo relayer.</p>
      </div>
      <Card className="max-w-xl">
        <CardHeader rule="double" className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle>Demo wallet</CardTitle>
            <CardDescription>
              A fresh devnet key made in this tab. Nothing to install, no popups, gone when you
              close the tab.
            </CardDescription>
          </div>
          <Badge tone="positive">RECOMMENDED</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <div className="flex flex-col items-start gap-2">
            <Button onClick={onStart} disabled={disabledReason !== null}>
              Start with a demo wallet
            </Button>
            {disabledReason !== null && (
              <p className="text-sm text-tone-negative">{disabledReason}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
