import type { ComponentProps, CSSProperties } from 'react';
import { Toaster as Sonner } from 'sonner';
import type { Tone } from '../../tokens/tokens.ts';

export { toast } from 'sonner';

/**
 * Sonner injects unlayered CSS that beats Tailwind classes, so it is themed through its own
 * CSS variables, pointed at our tokens; they follow `data-theme` with everything else. The
 * `richColors` palettes get the same treatment (card ground, tone text and border: pairs the
 * token contrast test covers). The description colour is hardcoded in Sonner (no variable), so
 * an important utility overrides it.
 */
function richColorVars(kind: string, tone: Tone): Record<`--${string}`, string> {
  return {
    [`--${kind}-bg`]: 'var(--card)',
    [`--${kind}-text`]: `var(--tone-${tone})`,
    [`--${kind}-border`]: `var(--tone-${tone})`,
  };
}

const TOKEN_VARS: CSSProperties & Record<`--${string}`, string> = {
  '--normal-bg': 'var(--card)',
  '--normal-text': 'var(--foreground)',
  '--normal-border': 'var(--border)',
  '--border-radius': 'var(--radius-md)',
  ...richColorVars('success', 'positive'),
  ...richColorVars('info', 'info'),
  ...richColorVars('warning', 'caution'),
  ...richColorVars('error', 'negative'),
};

export function Toaster({ style, toastOptions, ...props }: ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      className="toaster"
      style={{ ...TOKEN_VARS, ...style }}
      toastOptions={{
        ...toastOptions,
        style: { boxShadow: 'none', ...toastOptions?.style },
        classNames: { description: 'text-muted-foreground!', ...toastOptions?.classNames },
      }}
      {...props}
    />
  );
}
