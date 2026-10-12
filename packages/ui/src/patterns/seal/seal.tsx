import { cn } from '../../lib/cn.ts';
import { TONE_BORDER, TONE_TEXT, type Tone } from '../../tokens/tokens.ts';

export type SealProps = {
  tone: Tone;
  /** Large centre mark, e.g. a tier letter. */
  letter?: string;
  label: string;
  caption?: string;
  className?: string;
};

/**
 * A pressed stamp: rotated double ring. Entrance runs on `--dur-stamp`, which the tokens
 * zero under reduced motion.
 */
export function Seal({ tone, letter, label, caption, className }: SealProps) {
  return (
    <div
      data-slot="seal"
      data-tone={tone}
      className={cn(
        'inline-flex size-36 rotate-(--stamp-rotate) flex-col items-center justify-center rounded-full border-4 border-double p-3 text-center',
        'motion-safe:animate-seal-press',
        TONE_TEXT[tone],
        TONE_BORDER[tone],
        className,
      )}
    >
      {letter !== undefined && (
        <span data-slot="seal-letter" className="font-display text-3xl leading-none">
          {letter}
        </span>
      )}
      <span
        data-slot="seal-label"
        className="font-mono text-xs tracking-(--tracking-caps) uppercase"
      >
        {label}
      </span>
      {caption !== undefined && (
        <span data-slot="seal-caption" className="font-mono text-xs">
          {caption}
        </span>
      )}
    </div>
  );
}
