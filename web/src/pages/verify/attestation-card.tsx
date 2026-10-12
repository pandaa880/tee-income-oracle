import { TONE_BORDER, TONE_TEXT, TONE_TINT } from '@tio/ui/tokens';
import type { ReactNode } from 'react';
import { shortAddress } from '../../domain/format.ts';
import type { VerifyView } from '../../domain/verify-view.ts';
import { ExternalLink } from '../layout/external-link.tsx';

export type AttestationCardProps = { view: VerifyView };

type FactProps = { label: string; children: ReactNode; mono?: boolean };

function Fact({ label, children, mono = false }: FactProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-sm break-all' : 'text-sm'}>{children}</dd>
    </div>
  );
}

/** What the chain says about this wallet's tier: the attestation account, decoded. */
export function AttestationCard({ view }: AttestationCardProps) {
  const { tier, facts } = view;
  const dates = `${facts.issued} · ${facts.expires}${facts.expired ? ' (expired)' : ''}`;
  return (
    <section
      aria-label="Attestation"
      className="flex flex-wrap items-center gap-5 rounded-md border border-border bg-card p-6"
    >
      <span
        role="img"
        aria-label={`Tier ${tier.letter}`}
        className={`inline-flex size-16 shrink-0 items-center justify-center rounded-md border-2 font-display text-3xl font-semibold ${TONE_TEXT[tier.tone]} ${TONE_BORDER[tier.tone]} ${TONE_TINT[tier.tone]}`}
      >
        {tier.letter}
      </span>
      <dl className="grid flex-1 basis-[32rem] grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-x-5 gap-y-3">
        <Fact label="Attestation" mono>
          <ExternalLink href={facts.explorer}>{shortAddress(facts.attestation)}</ExternalLink>
        </Fact>
        <Fact label="Written by">{facts.writtenBy}</Fact>
        <Fact label="Policy" mono>
          {facts.policy}
        </Fact>
        <Fact label="Issued · expires">{dates}</Fact>
        <Fact label="Enclave build">{`#${facts.build}`}</Fact>
      </dl>
    </section>
  );
}
