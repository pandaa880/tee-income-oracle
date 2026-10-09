import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProofBar } from './proof-bar.tsx';

describe('ProofBar', () => {
  it('renders items with an href as links', () => {
    render(<ProofBar items={[{ label: 'Build', href: 'https://example.com/build' }]} />);
    expect(screen.getByRole('link', { name: 'Build' })).toHaveAttribute(
      'href',
      'https://example.com/build',
    );
  });

  it('opens external links safely', () => {
    render(<ProofBar items={[{ label: 'Build', href: 'https://example.com/build' }]} />);
    const rel = screen.getByRole('link', { name: 'Build' }).getAttribute('rel') ?? '';
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  it('renders items without an href as plain text, not links', () => {
    render(<ProofBar items={[{ label: 'Policy v2' }]} />);
    expect(screen.getByText('Policy v2')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders every item in order', () => {
    render(
      <ProofBar
        items={[{ label: 'One' }, { label: 'Two', href: 'https://e.com' }, { label: 'Three' }]}
      />,
    );
    expect(screen.getAllByText(/^(One|Two|Three)$/).map((el) => el.textContent)).toEqual([
      'One',
      'Two',
      'Three',
    ]);
  });

  it('merges className', () => {
    const { container } = render(<ProofBar items={[{ label: 'x' }]} className="pb-x" />);
    expect(container.firstElementChild).toHaveClass('pb-x');
  });
});
