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

  it('shows a kicker above the label when an item has one', () => {
    render(<FlowStrip items={[{ label: 'LPs', note: 'supply the money', kicker: 'CAPITAL' }]} />);
    const item = screen.getByText('LPs').closest('[data-slot="flow-strip-item"]');
    expect(item?.textContent).toBe('CAPITALLPssupply the money');
  });

  it('puts one hidden arrow between neighbouring items, with or without a bracket', () => {
    const plain = render(<FlowStrip items={ITEMS} />);
    expect(plain.container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
    plain.unmount();
    const bracketed = render(<FlowStrip items={ITEMS} bracket={{ from: 1, to: 2, label: 'T' }} />);
    expect(bracketed.container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
  });

  it('groups the bracketed items together above the bracket label', () => {
    const { container } = render(
      <FlowStrip items={ITEMS} bracket={{ from: 1, to: 2, label: 'Trusted' }} />,
    );
    const group = container.querySelector('[data-slot="flow-strip-group"]');
    const inGroup = Array.from(group?.querySelectorAll('[data-slot="flow-strip-item"]') ?? []);
    expect(inGroup.map((el) => el.textContent)).toEqual([
      expect.stringContaining('Enclave'),
      expect.stringContaining('Oracle'),
    ]);
    expect(group?.lastElementChild?.textContent).toBe('Trusted');
  });
});
