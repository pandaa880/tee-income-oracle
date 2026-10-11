import type { Address } from '@solana/kit';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@tio/ui/accordion';
import { Badge } from '@tio/ui/badge';
import { Button } from '@tio/ui/button';
import { Card, CardContent, CardHeader } from '@tio/ui/card';
import { LedgerList, LedgerRow } from '@tio/ui/ledger';
import { formatCountdown, shortAddress } from '../../domain/format.ts';
import { PERSONAS } from '../../domain/personas.ts';
import type { PersonaId, Session } from '../../domain/types.ts';

export type ConsentStepProps = {
  session: Session;
  wallet: Address;
  persona: PersonaId;
  secondsLeft: number;
  onApprove: () => void;
  onCancel: () => void;
};

/** Styled after the ReBIT / Sahamati consent screen; the wallet signs the exact intent text. */
export function ConsentStep({
  session,
  wallet,
  persona,
  secondsLeft,
  onApprove,
  onCancel,
}: ConsentStepProps) {
  const account = PERSONAS.find((p) => p.id === persona)?.title ?? persona;
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-start">
      <Card>
        <CardHeader rule="double" className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
              Sandbox AA · consent request
            </p>
            <p>
              TEE Income Oracle (FIU) asks to view your deposit account once, to run a lender’s
              affordability policy on it.
            </p>
          </div>
          <Badge tone="caution">SIMULATED</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <LedgerList>
            <LedgerRow label="Account" value={`${account} · sandbox`} />
            <LedgerRow label="Data" value="Deposit transactions" />
            <LedgerRow label="Period" value="Last 12 months (365 days)" />
            <LedgerRow label="Access" value="View only · one-time fetch" />
            <LedgerRow
              label="Signed by"
              value="The Account Aggregator (data originates at the bank)"
            />
            <LedgerRow
              label="Who reads it"
              value="Only the attested enclave, encrypted to its key"
            />
            <LedgerRow label="What's kept" value="A tier on Solana. No transactions." />
          </LedgerList>
          <p className="text-xs text-muted-foreground">
            Styled after the ReBIT / Sahamati consent flow. In production your own AA app shows this
            screen.
          </p>
        </CardContent>
      </Card>
      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-xl leading-tight">Approve with your wallet</h2>
          <span className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
            expires in {formatCountdown(secondsLeft)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Your wallet signs this exact text. It ties the session to your wallet, so the tier can
          only land on your address. It isn’t a transaction and costs nothing.
        </p>
        <p className="font-mono text-xs text-muted-foreground">Signing as {shortAddress(wallet)}</p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted p-4 font-mono text-xs leading-relaxed">
          {session.intent}
        </pre>
        <div className="flex gap-3">
          <Button onClick={onApprove} disabled={secondsLeft <= 0}>
            Approve & sign
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <Accordion type="single" collapsible>
          <AccordionItem value="policy">
            <AccordionTrigger>What is the policy hash?</AccordionTrigger>
            <AccordionContent>
              The SHA-256 of the lender’s published scoring rules. The demo pools run the published
              default policy. The enclave puts the same hash into the attestation, so anyone can
              check which rules produced your tier.
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </section>
    </div>
  );
}
