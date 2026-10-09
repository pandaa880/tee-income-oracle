import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button.tsx';

describe('Button', () => {
  it('renders a button with its label', () => {
    render(<Button>Borrow</Button>);
    expect(screen.getByRole('button', { name: 'Borrow' })).toBeInTheDocument();
  });

  it('merges className', () => {
    render(<Button className="custom-x">Go</Button>);
    expect(screen.getByRole('button')).toHaveClass('custom-x');
  });

  it('gives each variant a different class set', () => {
    const variants = ['default', 'outline', 'ghost', 'link'] as const;
    const classSets = variants.map((variant) => {
      const { unmount } = render(<Button variant={variant}>x</Button>);
      const cls = screen.getByRole('button').className;
      unmount();
      return cls;
    });
    expect(new Set(classSets).size).toBe(variants.length);
  });

  it('gives each size a different class set', () => {
    const sizes = ['sm', 'md', 'lg'] as const;
    const classSets = sizes.map((size) => {
      const { unmount } = render(<Button size={size}>x</Button>);
      const cls = screen.getByRole('button').className;
      unmount();
      return cls;
    });
    expect(new Set(classSets).size).toBe(sizes.length);
  });

  it('renders the child element instead of a button with asChild', () => {
    render(
      <Button asChild>
        <a href="/loans">Loans</a>
      </Button>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Loans' })).toHaveAttribute('href', '/loans');
  });

  it('calls onClick', () => {
    const onClick = vi.fn<() => void>();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not call onClick when disabled', () => {
    const onClick = vi.fn<() => void>();
    render(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
