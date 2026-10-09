import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton } from './skeleton.tsx';

describe('Skeleton', () => {
  it('renders an element marked data-slot="skeleton"', () => {
    const { container } = render(<Skeleton />);
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it('merges className', () => {
    const { container } = render(<Skeleton className="h-4 w-20" />);
    expect(container.querySelector('[data-slot="skeleton"]')).toHaveClass('h-4', 'w-20');
  });
});
