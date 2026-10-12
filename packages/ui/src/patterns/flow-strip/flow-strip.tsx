import { cn } from '../../lib/cn.ts';

export type FlowStripProps = {
  items: readonly { label: string; note: string }[];
  /** Groups items `from`..`to` (inclusive, zero-based) under one label. */
  bracket?: { from: number; to: number; label: string };
  className?: string;
};

/**
 * A left-to-right role strip. The bracketed items get the strong rule and the bracket label
 * names that span. Labels must be unique.
 */
export function FlowStrip({ items, bracket, className }: FlowStripProps) {
  const inBracket = (i: number) => bracket !== undefined && i >= bracket.from && i <= bracket.to;
  return (
    <div data-slot="flow-strip" className={cn('flex flex-col gap-2', className)}>
      <ol className="flex flex-wrap items-stretch gap-2">
        {items.map((item, i) => (
          <li
            key={item.label}
            data-slot="flow-strip-item"
            data-bracketed={inBracket(i) ? 'true' : 'false'}
            className={cn(
              'flex flex-col rounded-sm border px-3 py-2',
              inBracket(i) ? 'border-rule-strong' : 'border-border',
            )}
          >
            <span className="font-medium">{item.label}</span>
            <span className="text-xs text-muted-foreground">{item.note}</span>
          </li>
        ))}
      </ol>
      {bracket !== undefined && (
        <p
          data-slot="flow-strip-bracket"
          className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase"
        >
          {bracket.label}
        </p>
      )}
    </div>
  );
}
