import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Stepper } from './stepper.tsx';

const STEPS = [
  { label: 'Wallet', state: 'done' },
  { label: 'Consent', state: 'current' },
  { label: 'Result', state: 'todo' },
] as const;

describe('Stepper', () => {
  it('renders an ordered list with one item per step, in order', () => {
    render(<Stepper steps={[...STEPS]} />);
    expect(screen.getByRole('list').tagName).toBe('OL');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Wallet'),
      expect.stringContaining('Consent'),
      expect.stringContaining('Result'),
    ]);
  });

  it('exposes each step state as data-state', () => {
    render(<Stepper steps={[...STEPS]} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'current', 'todo']);
  });

  it('marks only the current step with aria-current="step"', () => {
    render(<Stepper steps={[...STEPS]} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([null, 'step', null]);
  });

  it('merges className', () => {
    render(<Stepper steps={[...STEPS]} className="step-x" />);
    expect(screen.getByRole('list')).toHaveClass('step-x');
  });

  it('marks done steps with a check and screen-reader text, not with dimming', () => {
    render(<Stepper steps={[...STEPS]} />);
    const [done, current, todo] = screen.getAllByRole('listitem');
    expect(done).toHaveTextContent('✓');
    expect(done).toHaveTextContent('(done)');
    expect(current).not.toHaveTextContent('(done)');
    expect(todo).not.toHaveTextContent('✓');
    expect(todo?.className).not.toMatch(/opacity-/);
  });
});
