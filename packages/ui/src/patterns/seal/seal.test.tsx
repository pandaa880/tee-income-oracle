import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TONES } from '../../tokens/tokens.ts';
import { Seal } from './seal.tsx';

describe('Seal', () => {
  it.each(TONES)('renders tone %s as data-tone on the seal', (tone) => {
    const { container } = render(<Seal tone={tone} label="Verified" />);
    expect(container.querySelector('[data-slot="seal"]')).toHaveAttribute('data-tone', tone);
  });

  it('renders the label, letter and caption', () => {
    render(<Seal tone="positive" letter="A" label="Verified" caption="Policy v2" />);
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('Policy v2')).toBeInTheDocument();
  });

  it('omits letter and caption when not given', () => {
    const { container } = render(<Seal tone="neutral" label="Pending" />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="seal-letter"]')).toBeNull();
    expect(container.querySelector('[data-slot="seal-caption"]')).toBeNull();
  });

  it('merges className on the seal', () => {
    const { container } = render(<Seal tone="info" label="x" className="seal-x" />);
    expect(container.querySelector('[data-slot="seal"]')).toHaveClass('seal-x');
  });
});
