import { SectionBand } from './section-band.tsx';
import { SectionHeading } from './section-heading.tsx';

const CARDS = [
  [
    'The product',
    'A bank receipt for each loan today. Payout and repayment checks are on the roadmap.',
  ],
  ['Who it’s for', 'Co-lending banks, pool buyers and debt funds that lend to NBFCs.'],
] as const;

/**
 * 07: the market, in one sourced number. ₹2.2 lakh crore = ICRA's FY2026 securitisation estimate
 * for NBFCs and HFCs (ICRA Structured Finance, April and June 2026). "A third" = RBI (NBFC –
 * Transfer and Distribution of Credit Risk) Directions, 2025, RBI/DOR/2025-26/352, ¶39–40: a buyer
 * that can't check every loan may check one-third by value and number if the seller keeps 10%.
 */
export function Market() {
  return (
    <SectionBand labelledBy="market-h" tinted>
      <SectionHeading
        id="market-h"
        kicker="07 · The market"
        title="₹2.2 lakh crore of NBFC loans were securitised in FY26."
      />
      <p className="max-w-prose text-lg">
        When loans are sold directly, RBI rules let a buyer check as few as a third of them one by
        one.
      </p>
      <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2">
        {CARDS.map(([title, body]) => (
          <li
            key={title}
            className="flex flex-col gap-2 rounded-sm border border-border bg-background p-5"
          >
            <h3 className="font-mono text-sm tracking-(--tracking-caps) text-muted-foreground uppercase">
              {title}
            </h3>
            <p className="text-lg">{body}</p>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        Sources: ICRA, FY2026 securitisation estimate (NBFCs and HFCs). RBI NBFC Transfer and
        Distribution of Credit Risk Directions, 2025, ¶39–40.
      </p>
    </SectionBand>
  );
}
