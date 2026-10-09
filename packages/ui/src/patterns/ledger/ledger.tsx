import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';
import { TONE_TEXT, type Tone } from '../../tokens/tokens.ts';

/** A ledger: a description list of label/value lines on hairline rules. */
export function LedgerList({ className, ...props }: ComponentProps<'dl'>) {
  return <dl data-slot="ledger" className={cn('flex flex-col', className)} {...props} />;
}

export type LedgerRowProps = {
  label: ReactNode;
  value: ReactNode;
  /** Value in mono (hashes, amounts, addresses). */
  mono?: boolean;
  tone?: Tone;
  /** A total line: closed by the double rule, value in medium weight. */
  strong?: boolean;
  className?: string;
};

export function LedgerRow({
  label,
  value,
  mono = false,
  tone,
  strong = false,
  className,
}: LedgerRowProps) {
  return (
    <div
      data-slot="ledger-row"
      data-tone={tone}
      className={cn(
        'flex items-baseline justify-between gap-4 py-2',
        strong
          ? 'border-b-3 border-double border-rule-strong font-medium'
          : 'border-b border-border',
        className,
      )}
    >
      <dt className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
        {label}
      </dt>
      <dd
        className={cn('text-right', mono && 'font-mono text-sm break-all', tone && TONE_TEXT[tone])}
      >
        {value}
      </dd>
    </div>
  );
}
