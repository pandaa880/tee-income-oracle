import { useId } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@tio/ui/button';
import { cn } from '@tio/ui/cn';
import { StatusBadge } from '@tio/ui/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tio/ui/table';
import type { BookRow } from '../../domain/book.ts';
import { bookHealthLabel } from '../../domain/credential-copy.ts';
import { credentialTone } from '../../domain/credential-tone.ts';
import { explorerAddressUrl } from '../../domain/explorer.ts';
import { formatAge, formatTokens, shortAddress } from '../../domain/format.ts';
import { ExternalLink } from '../layout/external-link.tsx';

export type LoanTableProps = { rows: readonly BookRow[]; cluster: string };

const COLUMNS = ['Borrower', 'Tier', 'Amount', 'Out', 'Tier age', 'Build', 'Credential', 'Links'];

/**
 * Below `lg` the table stacks (its eight columns need ~830 px, so a smaller breakpoint would
 * scroll sideways): each row becomes a block and each cell a label/value line, the
 * label coming from `data-label` (CODING-GUIDELINES §3: tables collapse to ledger rows).
 */
const STACK = {
  table: 'max-lg:block',
  header: 'max-lg:sr-only',
  body: 'max-lg:block',
  row: 'max-lg:block max-lg:py-2',
  cell: 'max-lg:flex max-lg:justify-between max-lg:gap-4 max-lg:py-1 max-lg:text-right max-lg:before:font-mono max-lg:before:text-xs max-lg:before:text-muted-foreground max-lg:before:uppercase max-lg:before:content-[attr(data-label)]',
};

function LoanRow({ row, cluster }: { row: BookRow; cluster: string }) {
  // Explicit roles: `display: block` (stacked) drops the native table semantics in WebKit.
  const cell = (label: string, className?: string) => ({
    role: 'cell',
    'data-label': label,
    className: cn(STACK.cell, className),
  });
  const of = <span className="sr-only">{` of ${shortAddress(row.borrower)}`}</span>;
  return (
    <TableRow role="row" className={STACK.row}>
      <TableCell {...cell('Borrower', 'font-mono')}>{shortAddress(row.borrower)}</TableCell>
      <TableCell {...cell('Tier')}>{row.tierAtBorrow ?? '—'}</TableCell>
      <TableCell {...cell('Amount')} numeric>
        {formatTokens(row.amount)}
      </TableCell>
      <TableCell {...cell('Out')}>{formatAge(row.outstandingSecs)}</TableCell>
      <TableCell {...cell('Tier age')}>
        {row.tierAgeSecs === null ? '—' : formatAge(row.tierAgeSecs)}
      </TableCell>
      <TableCell {...cell('Build')}>
        {row.measurementId === null ? '—' : `#${row.measurementId}`}
      </TableCell>
      <TableCell {...cell('Credential')}>
        <div className="flex flex-col items-end gap-1 lg:items-start">
          <StatusBadge tone={credentialTone(row.health)} label={bookHealthLabel(row.health)} />
          {row.reattested && row.currentTier !== null && (
            <span className="text-xs text-muted-foreground">
              {`re-attested since borrow · now ${row.currentTier}`}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell {...cell('Links')}>
        <span className="inline-flex flex-wrap justify-end gap-x-3">
          <ExternalLink href={explorerAddressUrl(cluster, row.loanAddress)}>Loan{of}</ExternalLink>
          {row.attestationAddress !== null && (
            <ExternalLink href={explorerAddressUrl(cluster, row.attestationAddress)}>
              Attestation{of}
            </ExternalLink>
          )}
        </span>
      </TableCell>
    </TableRow>
  );
}

/** Every open loan of the pool, newest first; an empty pool offers the way to make one. */
export function LoanTable({ rows, cluster }: LoanTableProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <h2 id={titleId} className="font-display text-xl leading-tight">
        Loans in this pool
      </h2>
      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground">No open loans in this pool yet.</p>
          <Button asChild variant="outline">
            <Link to="/borrow">Borrow from this pool</Link>
          </Button>
        </div>
      ) : (
        <Table role="table" aria-labelledby={titleId} className={STACK.table}>
          <TableHeader role="rowgroup" className={STACK.header}>
            <TableRow role="row">
              {COLUMNS.map((name) => (
                <TableHead key={name} role="columnheader">
                  {name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody role="rowgroup" className={STACK.body}>
            {rows.map((row) => (
              <LoanRow key={row.loanAddress} row={row} cluster={cluster} />
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
