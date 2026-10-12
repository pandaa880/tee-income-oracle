import { cva } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';
import { TONE_BORDER, TONE_TEXT, TONE_TINT, type Tone } from '../../tokens/tokens.ts';

const badgeVariants = cva(
  'inline-flex items-center rounded-sm px-2 py-0.5 font-mono text-xs tracking-(--tracking-caps) uppercase',
  {
    variants: {
      variant: {
        default: 'bg-muted text-foreground',
        outline: 'border border-border bg-transparent text-foreground',
        /** Sentence-case status chip on a wash of its tone ("fresh", "old policy"). */
        soft: 'border border-border font-sans font-semibold tracking-normal normal-case',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type BadgeProps = ComponentProps<'span'> & {
  variant?: 'default' | 'outline' | 'soft';
  tone?: Tone;
};

/** Small label chip; `tone` colours the text and border (and the fill, for `soft`). */
export function Badge({ className, variant, tone, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      data-tone={tone}
      className={cn(
        badgeVariants({ variant }),
        tone && ['border', TONE_TEXT[tone], TONE_BORDER[tone]],
        tone && variant === 'soft' && TONE_TINT[tone],
        className,
      )}
      {...props}
    />
  );
}
