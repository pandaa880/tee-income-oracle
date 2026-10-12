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

/**
 * Hairline stroke icon in the text colour; decorative, the button's label names the action.
 * `data-icon` lets tests tell the glyphs apart: hidden from assistive tech, they have no name.
 */
const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
} as const;

/** Shown in the dark theme: the action is "switch to light". */
function SunIcon() {
  return (
    <svg data-icon="sun" {...ICON_PROPS}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </svg>
  );
}

/** Shown in the light theme: the action is "switch to dark". */
function MoonIcon() {
  return (
    <svg data-icon="moon" {...ICON_PROPS}>
      <path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a7 7 0 0 0 9.7 9.7z" />
    </svg>
  );
}

export type ThemeToggleProps = { className?: string };

/**
 * Switches `data-theme` on `<html>` between the paper and carbon-copy themes. An icon button:
 * the icon shows the theme it switches to, `aria-label` and `title` say it in words.
 */
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

  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button
      type="button"
      data-slot="theme-toggle"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-10 items-center justify-center rounded-sm border border-border text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
        className,
      )}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
