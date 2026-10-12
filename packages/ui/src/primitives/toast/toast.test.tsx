import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubMatchMedia } from '../../test-match-media.ts';
import { Toaster, toast } from './toast.tsx';

beforeEach(() => {
  stubMatchMedia(false);
});

afterEach(() => {
  toast.dismiss();
  vi.unstubAllGlobals();
});

describe('Toaster', () => {
  it('renders the notifications region', () => {
    render(<Toaster />);
    expect(screen.getByRole('region', { name: /notifications/i })).toBeInTheDocument();
  });

  it('shows a toast raised through the re-exported toast()', async () => {
    render(<Toaster />);
    act(() => {
      toast('Transaction sent');
    });
    expect(await screen.findByText('Transaction sent')).toBeInTheDocument();
  });

  it('themes Sonner through its CSS variables and keeps a consumer style', async () => {
    render(<Toaster style={{ zIndex: 7 }} />);
    act(() => {
      toast('x');
    });
    await screen.findByText('x');
    const toaster = document.querySelector<HTMLElement>('[data-sonner-toaster]');
    expect(toaster?.style.getPropertyValue('--normal-bg')).toBe('var(--card)');
    expect(toaster?.style.zIndex).toBe('7');
  });

  it('overrides the hardcoded description colour, merging consumer classNames', async () => {
    render(<Toaster toastOptions={{ classNames: { title: 'title-x' } }} />);
    act(() => {
      toast('Sent', { description: 'Slot 42' });
    });
    expect(await screen.findByText('Slot 42')).toHaveClass('text-muted-foreground!');
    expect(screen.getByText('Sent')).toHaveClass('title-x');
  });

  it.each([
    ['success', 'positive'],
    ['info', 'info'],
    ['warning', 'caution'],
    ['error', 'negative'],
  ])('maps the richColors %s palette to tokens (tone %s on card)', async (kind, tone) => {
    render(<Toaster richColors />);
    act(() => {
      toast('y');
    });
    await screen.findByText('y');
    const style = document.querySelector<HTMLElement>('[data-sonner-toaster]')?.style;
    expect(style?.getPropertyValue(`--${kind}-bg`)).toBe('var(--card)');
    expect(style?.getPropertyValue(`--${kind}-text`)).toBe(`var(--tone-${tone})`);
    expect(style?.getPropertyValue(`--${kind}-border`)).toBe(`var(--tone-${tone})`);
  });
});
