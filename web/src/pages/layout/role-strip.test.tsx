import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RoleStrip } from './role-strip.tsx';

describe('RoleStrip', () => {
  it('says who funds whom, left to right', () => {
    render(<RoleStrip />);
    expect(screen.getByText('Who funds whom · money flows left to right')).toBeInTheDocument();
    for (const role of ['LPs', 'Credit vehicle', 'NBFC', 'Borrower']) {
      expect(screen.getByText(role)).toBeInTheDocument();
    }
  });

  it('brackets the two roles the demo pool plays at once', () => {
    render(<RoleStrip />);
    expect(
      screen.getByText('DEMO POOL = NBFC + CREDIT VEHICLE IN ONE PROGRAM'),
    ).toBeInTheDocument();
  });

  it('names what each party is above its label', () => {
    render(<RoleStrip />);
    for (const kicker of ['Capital', 'On-chain reader', 'Regulated lender', 'Data subject']) {
      expect(screen.getByText(kicker)).toBeInTheDocument();
    }
  });
});
