import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn.ts';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'tio-theme';

/** Stored choice, then the system preference, then light. Storage may be blocked. */
function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private mode or blocked site data: fall through to the system preference.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function persist(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not persisted; the toggle still works for this page view.
  }
}

export type ThemeToggleProps = { className?: string };

/** Switches `data-theme` on `<html>` between the paper and carbon-copy themes. */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    persist(next);
    setTheme(next);
  }

  return (
    <button
      type="button"
      data-slot="theme-toggle"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      className={cn(
        'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border font-mono text-xs tracking-(--tracking-caps) text-foreground uppercase hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
        className,
      )}
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
