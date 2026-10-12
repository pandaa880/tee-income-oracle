import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input, Label } from './input.tsx';

describe('Input', () => {
  it('is found by its Label', () => {
    render(
      <>
        <Label htmlFor="wallet">Wallet</Label>
        <Input id="wallet" />
      </>,
    );
    expect(screen.getByLabelText('Wallet')).toBeInstanceOf(HTMLInputElement);
  });

  it('forwards className and native props', () => {
    render(<Input aria-label="Amount" className="in-x" placeholder="0.00" disabled />);
    const input = screen.getByRole('textbox', { name: 'Amount' });
    expect(input).toHaveClass('in-x');
    expect(input).toHaveAttribute('placeholder', '0.00');
    expect(input).toBeDisabled();
  });

  it('forwards className on Label', () => {
    render(<Label className="lab-x">Name</Label>);
    expect(screen.getByText('Name')).toHaveClass('lab-x');
  });
});
