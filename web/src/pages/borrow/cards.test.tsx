import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { messageFor } from '../../domain/errors.ts';
import type { AppError } from '../../domain/types.ts';
import { ErrorCard } from './error-card.tsx';
import { RecoveringCard } from './recovering-card.tsx';

const CASES: readonly (readonly [string, AppError, string | null, string | null])[] = [
  ['restart', { code: 'session_expired' }, 'Start again', 'onRestart'],
  ['retry', { code: 'rate_limited' }, 'Try again', 'onRetry'],
  ['reattest', { code: 'enclave_revoked' }, 'Re-attest', 'onReattest'],
  ['none', { code: 'sponsorship_exhausted' }, null, null],
];

function setup(error: AppError) {
  const handlers = {
    onRestart: vi.fn<() => void>(),
    onRetry: vi.fn<() => void>(),
    onReattest: vi.fn<() => void>(),
  };
  render(<ErrorCard error={error} {...handlers} />);
  return handlers;
}

describe('ErrorCard', () => {
  it('is an alert with the title, the detail and the code', () => {
    setup({ code: 'session_expired' });
    const { title, detail } = messageFor({ code: 'session_expired' });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.getByText(/session_expired/)).toBeInTheDocument();
  });

  it('adds the shape rule to a bad_transaction code', () => {
    setup({ code: 'bad_transaction', rule: 7 });
    expect(screen.getByText(/bad_transaction · rule 7/)).toBeInTheDocument();
  });

  it('adds the program error number to a simulation failure', () => {
    setup({ code: 'simulation_failed', custom: 6008 });
    expect(screen.getByText(/simulation_failed · 6008/)).toBeInTheDocument();
  });

  it.each(CASES)(
    'for a %s error offers exactly one matching action',
    (_, error, label, handler) => {
      const handlers = setup(error);
      const buttons = screen.queryAllByRole('button');
      if (label === null || handler === null) {
        expect(buttons).toHaveLength(0);
        return;
      }
      expect(buttons).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: label }));
      for (const [name, fn] of Object.entries(handlers)) {
        expect(fn).toHaveBeenCalledTimes(name === handler ? 1 : 0);
      }
    },
  );
});

describe('RecoveringCard', () => {
  it('says the connection was lost while the chain is checked', () => {
    render(<RecoveringCard onRestart={vi.fn<() => void>()} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Connection lost — checking the chain…' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/keeps working/i)).toBeInTheDocument();
  });

  it('always offers to start again', () => {
    const onRestart = vi.fn<() => void>();
    render(<RecoveringCard onRestart={onRestart} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(onRestart).toHaveBeenCalledOnce();
  });
});

describe('ErrorCard fallback', () => {
  it('gives an error with no action of its own the page fallback, so it is never a dead end', () => {
    const onRestart = vi.fn<() => void>();
    render(
      <ErrorCard
        error={{ code: 'protocol_error' }}
        onRestart={onRestart}
        onRetry={vi.fn<() => void>()}
        onReattest={vi.fn<() => void>()}
        fallback="restart"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('keeps the error own action over the fallback', () => {
    render(
      <ErrorCard
        error={{ code: 'rate_limited' }}
        onRestart={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
        onReattest={vi.fn<() => void>()}
        fallback="restart"
      />,
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start again' })).not.toBeInTheDocument();
  });
});
