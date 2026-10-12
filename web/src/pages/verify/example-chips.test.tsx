import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { exampleWallets } from '../../domain/example-wallets.ts';
import { renderWithRouter } from '../../test-support/render.tsx';
import { ExampleChips } from './example-chips.tsx';

describe('ExampleChips', () => {
  it('renders nothing for a cluster without examples', async () => {
    await renderWithRouter(<ExampleChips examples={exampleWallets('localnet')} />, '/verify');
    expect(screen.queryByRole('navigation', { name: 'Example wallets' })).not.toBeInTheDocument();
    expect(screen.queryByText(/no wallet handy/i)).not.toBeInTheDocument();
  });

  it('renders one link per example, labelled by who the borrower is', async () => {
    const examples = exampleWallets('devnet');
    await renderWithRouter(<ExampleChips examples={examples} />, '/verify');
    const nav = screen.getByRole('navigation', { name: 'Example wallets' });
    expect(nav).toHaveTextContent(/no wallet handy\?/i);
    for (const example of examples) {
      expect(screen.getByRole('link', { name: example.label })).toHaveAttribute(
        'href',
        `/verify?wallet=${example.wallet}`,
      );
    }
  });
});
