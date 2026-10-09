import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubMatchMedia } from '../../test-match-media.ts';
import { ThemeToggle } from './theme-toggle.tsx';

function theme(): string | undefined {
  return document.documentElement.dataset['theme'];
}

/**
 * Replaces `localStorage` with an in-memory fake for one test. Spying on happy-dom's Storage
 * leaks across tests (restoreAllMocks doesn't undo it), so the whole object is stubbed.
 */
function stubStorage(overrides: Partial<Pick<Storage, 'getItem' | 'setItem'>> = {}) {
  const data = new Map<string, string>();
  const storage = {
    getItem: vi.fn<(key: string) => string | null>((key) => data.get(key) ?? null),
    setItem: vi.fn<(key: string, value: string) => void>((key, value) => {
      data.set(key, value);
    }),
    ...overrides,
  };
  vi.stubGlobal('localStorage', storage);
  return storage;
}

function denied(): never {
  throw new Error('denied');
}

beforeEach(() => {
  delete document.documentElement.dataset['theme'];
  stubMatchMedia(false);
  stubStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset['theme'];
});

describe('ThemeToggle', () => {
  it('renders a single button whose name mentions the theme', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument();
  });

  it('uses the system light preference when nothing is stored', () => {
    stubMatchMedia(false);
    render(<ThemeToggle />);
    expect(theme()).toBe('light');
  });

  it('uses the system dark preference when nothing is stored', () => {
    stubMatchMedia(true);
    render(<ThemeToggle />);
    expect(theme()).toBe('dark');
  });

  it('prefers a stored theme over the system preference', () => {
    stubStorage({ getItem: () => 'dark' });
    stubMatchMedia(false);
    render(<ThemeToggle />);
    expect(theme()).toBe('dark');
  });

  it('flips data-theme on <html> when clicked', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: /theme/i }));
    expect(theme()).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: /theme/i }));
    expect(theme()).toBe('light');
  });

  it('persists the chosen theme to localStorage', () => {
    const { setItem } = stubStorage();
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: /theme/i }));
    expect(setItem).toHaveBeenLastCalledWith(expect.any(String), 'dark');
  });

  it('still toggles when localStorage throws on read and write', () => {
    stubStorage({ getItem: denied, setItem: denied });
    stubMatchMedia(false);
    render(<ThemeToggle />);
    expect(theme()).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: /theme/i }));
    expect(theme()).toBe('dark');
  });

  it('restores the persisted theme on the next mount', () => {
    const { unmount } = render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: /theme/i }));
    unmount();
    delete document.documentElement.dataset['theme'];
    render(<ThemeToggle />);
    expect(theme()).toBe('dark');
  });

  it('ignores an invalid stored value and uses the system preference', () => {
    stubStorage({ getItem: () => 'purple' });
    stubMatchMedia(true);
    render(<ThemeToggle />);
    expect(theme()).toBe('dark');
  });

  it('merges className', () => {
    render(<ThemeToggle className="tt-x" />);
    expect(screen.getByRole('button', { name: /theme/i })).toHaveClass('tt-x');
  });
});
