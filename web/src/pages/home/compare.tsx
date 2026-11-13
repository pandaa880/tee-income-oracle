import { cn } from '@tio/ui/cn';
import { LedgerList, LedgerRow } from '@tio/ui/ledger';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tio/ui/table';
import { TONE_TINT } from '@tio/ui/tokens';
import { type Capability, isBuilt, stageLabel, stageOf } from '../../domain/roadmap.ts';
import { SectionBand } from './section-band.tsx';
import { SectionHeading } from './section-heading.tsx';

const OPTIONS = ['TIO', 'Sampling audit', 'Servicer report', 'Bureau scrub'] as const;

/** The TIO column sits on a light wash of the positive tone. */
const TIO_COLUMN = TONE_TINT.positive;

type Row = {
  label: string;
  /** One cell per option, in `OPTIONS` order. */
  cells: readonly [string, string, string, string];
  /** The capability TIO's cell depends on; an unbuilt one gets its stage in brackets. */
  tioCapability?: Capability;
};

const ROWS: readonly Row[] = [
  {
    label: 'Loans covered',
    cells: ['Every consented loan', 'A sample', 'All', 'All'],
    tioCapability: 'loan_id_receipts',
  },
  {
    label: 'Where the data comes from',
    cells: ['Borrower’s bank', 'NBFC’s files', 'NBFC', 'Lenders’ own reports'],
  },
  {
    label: 'Shows the loan was paid out',
    cells: ['Yes', 'Sampled files only', 'Claimed by the NBFC', 'No'],
    tioCapability: 'payout_proof',
  },
  {
    label: 'Shows EMIs actually paid',
    cells: ['Yes, monthly', 'No', 'Claimed by the NBFC', 'Reported by lenders, later'],
    tioCapability: 'repayment_check',
  },
  {
    label: 'Borrower’s statement shared',
    cells: ['Never leaves the enclave', 'Copied into files', 'Not shared', 'Not shared'],
  },
  {
    label: 'Blind spots',
    cells: [
      'Cash collections, unlinked accounts',
      'Everything not sampled',
      'Whatever the NBFC leaves out',
      'Loans not yet reported',
    ],
  },
];

function cellText(row: Row, option: number): string {
  const text = row.cells[option] ?? '';
  if (option !== 0 || row.tioCapability === undefined) return text;
  const stage = stageOf(row.tioCapability);
  return isBuilt(stage) ? text : `${text} (${stageLabel(stage).toLowerCase()})`;
}

/** 04: TIO beside the checks funders use today. A table from `md` up, one ledger per option below. */
export function Compare() {
  return (
    <SectionBand labelledBy="compare-h" tinted>
      <SectionHeading
        id="compare-h"
        kicker="04 · Why it’s different"
        title="The only check the NBFC can’t write itself."
      />
      <div className="hidden md:block">
        <Table className="text-lg">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">
                <span className="sr-only">Check</span>
              </TableHead>
              {OPTIONS.map((option, i) => (
                <TableHead key={option} scope="col" className={cn(i === 0 && TIO_COLUMN)}>
                  {option}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map((row) => (
              <TableRow key={row.label}>
                <TableHead scope="row">{row.label}</TableHead>
                {OPTIONS.map((option, i) => (
                  <TableCell key={option} className={cn(i === 0 && TIO_COLUMN)}>
                    {cellText(row, i)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-col gap-8 md:hidden">
        {OPTIONS.map((option, i) => (
          <div key={option} className="flex flex-col gap-2">
            <h3 className="font-display text-xl">{option}</h3>
            <LedgerList>
              {ROWS.map((row) => (
                <LedgerRow key={row.label} label={row.label} value={cellText(row, i)} />
              ))}
            </LedgerList>
          </div>
        ))}
      </div>
    </SectionBand>
  );
}
