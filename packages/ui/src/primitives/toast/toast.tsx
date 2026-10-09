import type { ComponentProps, CSSProperties } from 'react';
import { Toaster as Sonner } from 'sonner';

export { toast } from 'sonner';

/**
 * Sonner injects unlayered CSS that beats Tailwind classes, so it is themed through its own
 * CSS variables, pointed at our tokens; they follow `data-theme` with everything else. The
 * description colour is hardcoded in Sonner (no variable), so an important utility overrides it.
 */
const TOKEN_VARS: CSSProperties & Record<`--${string}`, string> = {
  '--normal-bg': 'var(--card)',
  '--normal-text': 'var(--foreground)',
  '--normal-border': 'var(--border)',
  '--border-radius': 'var(--radius-md)',
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
