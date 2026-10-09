import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TONES } from '../../tokens/tokens.ts';
import { StatusBadge } from './status-badge.tsx';

describe('StatusBadge', () => {
  it.each(TONES)('renders label with tone %s', (tone) => {
    render(<StatusBadge tone={tone} label="FRESH" />);
    const badge = screen.getByText('FRESH');
    expect(badge).toHaveAttribute('data-slot', 'status-badge');
    expect(badge).toHaveAttribute('data-tone', tone);
  });

  it('gives each tone a different class set', () => {
    const classSets = TONES.map((tone) => {
      const { unmount } = render(<StatusBadge tone={tone} label="x" />);
      const cls = screen.getByText('x').className;
      unmount();
      return cls;
    });
    expect(new Set(classSets).size).toBe(TONES.length);
  });

  it('merges className', () => {
    render(<StatusBadge tone="neutral" label="x" className="sb-x" />);
    expect(screen.getByText('x')).toHaveClass('sb-x');
  });
});
