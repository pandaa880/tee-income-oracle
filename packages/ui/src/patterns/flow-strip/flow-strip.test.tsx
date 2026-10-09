import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FlowStrip } from './flow-strip.tsx';

const ITEMS = [
  { label: 'Borrower', note: 'consents' },
  { label: 'Enclave', note: 'scores' },
  { label: 'Oracle', note: 'attests' },
  { label: 'Pool', note: 'lends' },
];

function itemsOf(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('[data-slot="flow-strip-item"]'));
}

describe('FlowStrip', () => {
  it('renders every item label and note in order', () => {
    const { container } = render(<FlowStrip items={ITEMS} />);
    expect(itemsOf(container).map((el) => el.textContent)).toEqual([
      expect.stringContaining('Borrower'),
      expect.stringContaining('Enclave'),
      expect.stringContaining('Oracle'),
      expect.stringContaining('Pool'),
    ]);
    expect(screen.getByText('scores')).toBeInTheDocument();
  });

  it('renders no bracket when none is given', () => {
    const { container } = render(<FlowStrip items={ITEMS} />);
    expect(container.querySelector('[data-slot="flow-strip-bracket"]')).toBeNull();
  });

  it('renders the bracket label and flags the items it spans (inclusive, zero-based)', () => {
    const { container } = render(
      <FlowStrip items={ITEMS} bracket={{ from: 1, to: 2, label: 'Trusted' }} />,
    );
    expect(screen.getByText('Trusted').closest('[data-slot="flow-strip-bracket"]')).not.toBeNull();
    expect(itemsOf(container).map((el) => el.getAttribute('data-bracketed'))).toEqual([
      'false',
      'true',
      'true',
      'false',
    ]);
  });

  it('merges className', () => {
    const { container } = render(<FlowStrip items={ITEMS} className="fs-x" />);
    expect(container.firstElementChild).toHaveClass('fs-x');
  });
});
