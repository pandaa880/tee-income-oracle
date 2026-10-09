import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table.tsx';

function Example() {
  return (
    <Table className="t-x">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow className="r-x">
          <TableCell>Alice</TableCell>
          <TableCell numeric>1,000.00</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

describe('Table', () => {
  it('renders semantic table elements', () => {
    render(<Example />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Name',
      'Amount',
    ]);
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(within(screen.getAllByRole('row')[1] as HTMLElement).getAllByRole('cell')).toHaveLength(
      2,
    );
  });

  it('forwards className', () => {
    render(<Example />);
    expect(screen.getByRole('table')).toHaveClass('t-x');
    expect(screen.getAllByRole('row')[1]).toHaveClass('r-x');
  });

  it('styles numeric cells differently from plain cells', () => {
    render(<Example />);
    expect(screen.getByText('1,000.00').className).not.toBe(screen.getByText('Alice').className);
  });
});
