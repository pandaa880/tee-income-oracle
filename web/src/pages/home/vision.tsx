import { SectionBand } from './section-band.tsx';
import { SectionHeading } from './section-heading.tsx';

const RAILS = [
  ['Co-lending', 'The bank sees that its share is backed by real loans.'],
  ['Securitisation', 'Pool buyers check every loan, not a sample.'],
  ['Debt funds', 'Lend against a verified book.'],
  ['On-chain vaults', 'A program releases funds only against receipts.'],
  ['Other open-banking markets', 'The same check on another bank-data network.'],
] as const;

/** 08: where the same receipt fits next. */
export function Vision() {
  return (
    <SectionBand labelledBy="vision-h">
      <SectionHeading
        id="vision-h"
        kicker="08 · The vision"
        title="One receipt, every loan rail."
      />
      <ul className="m-0 grid list-none grid-cols-1 gap-6 border-t-3 border-double border-rule-strong p-0 pt-6 sm:grid-cols-2 lg:grid-cols-5">
        {RAILS.map(([name, line]) => (
          <li key={name} className="flex flex-col gap-1">
            <strong className="font-display text-xl font-medium">{name}</strong>
            <span className="text-muted-foreground">{line}</span>
          </li>
        ))}
      </ul>
    </SectionBand>
  );
}
