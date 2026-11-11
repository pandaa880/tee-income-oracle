import { cn } from '@tio/ui/cn';
import { LedgerList, LedgerRow } from '@tio/ui/ledger';
import { SectionBand } from './section-band.tsx';
import { SectionHeading } from './section-heading.tsx';

const STORY = [
  {
    when: 'Day 0 · tape',
    text: 'The NBFC sends a loan tape: every loan listed as eligible and paying.',
  },
  {
    when: 'Day 30 · funded',
    text: 'The funder checks a sample of loan files and wires the money.',
  },
  {
    when: 'Month 6 · report',
    text: 'The servicer report says collections are on track. The NBFC wrote the report.',
  },
  { when: 'Month 14 · audit', text: 'An audit finds loans that were never paid out.' },
] as const;

const FUNDER_SEES = [
  ['Loan tape', 'written by the NBFC'],
  ['Loan files', 'a sample'],
  ['Servicer report', 'written by the NBFC'],
  ['Escrow inflows', 'pool total only'],
] as const;

/** 01: how a bad pool is found today, as a short story, beside what the funder can actually see. */
export function Problem() {
  return (
    <SectionBand labelledBy="problem-h">
      <SectionHeading
        id="problem-h"
        kicker="01 · The problem"
        title="Funding an NBFC means trusting its spreadsheet."
      />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[3fr_2fr]">
        <ol className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
          {STORY.map((step, i) => (
            <li
              key={step.when}
              className={cn(
                'flex flex-col gap-2 rounded-sm border bg-card p-5',
                i === STORY.length - 1 ? 'border-tone-caution' : 'border-border',
              )}
            >
              <span className="font-mono text-sm tracking-(--tracking-caps) text-muted-foreground uppercase">
                {step.when}
              </span>
              <span className="text-lg">{step.text}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-col gap-3 rounded-sm border border-t-2 border-border border-t-rule-strong bg-card p-5">
          <h3 className="font-mono text-sm tracking-(--tracking-caps) text-muted-foreground uppercase">
            What the funder sees today
          </h3>
          <LedgerList>
            {FUNDER_SEES.map(([what, source]) => (
              <LedgerRow key={what} label={what} value={source} />
            ))}
          </LedgerList>
          <p className="text-sm text-muted-foreground">
            Illustrative story. The pattern follows public loan-book fraud cases.
          </p>
        </div>
      </div>
    </SectionBand>
  );
}
