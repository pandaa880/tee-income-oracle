import { cn } from '../../lib/cn.ts';

export type FlowStripItem = {
  label: string;
  note: string;
  /** A small caps line above the label naming the item's role ("CAPITAL"). */
  kicker?: string;
};

export type FlowStripProps = {
  items: readonly FlowStripItem[];
  /** Groups items `from`..`to` (inclusive, zero-based) under one label. */
  bracket?: { from: number; to: number; label: string };
  className?: string;
};

type Bracket = NonNullable<FlowStripProps['bracket']>;

function Item({ item, bracketed }: { item: FlowStripItem; bracketed: boolean }) {
  return (
    <li
      data-slot="flow-strip-item"
      data-bracketed={bracketed ? 'true' : 'false'}
      className={cn(
        'flex min-w-0 flex-[1_1_9rem] flex-col gap-0.5 rounded-sm px-3 py-2.5',
        bracketed
          ? 'border-[1.5px] border-tone-info bg-tone-info/10'
          : 'border border-dashed border-muted-foreground/60 bg-card',
      )}
    >
      {item.kicker !== undefined && (
        <span className="font-mono text-[0.625rem] tracking-[0.1em] text-muted-foreground uppercase">
          {item.kicker}
        </span>
      )}
      <span className="font-semibold">{item.label}</span>
      <span className="text-xs text-muted-foreground">{item.note}</span>
    </li>
  );
}

/** "→" between two items; hidden from assistive tech, the list order already says it. */
function Arrow() {
  return (
    <li aria-hidden="true" className="flex-none self-center font-mono text-muted-foreground">
      →
    </li>
  );
}

/** Items with arrows between them; `offset` is the first item's index in the whole strip. */
function withArrows(items: readonly FlowStripItem[], offset: number, bracket?: Bracket) {
  return items.flatMap((item, i) => {
    const index = offset + i;
    const inBracket = bracket !== undefined && index >= bracket.from && index <= bracket.to;
    const node = <Item key={item.label} item={item} bracketed={inBracket} />;
    return i === 0 ? [node] : [<Arrow key={`arrow-${item.label}`} />, node];
  });
}

/**
 * A left-to-right role strip. The bracketed items sit together above the bracket label, which
 * names that span. Labels must be unique.
 */
export function FlowStrip({ items, bracket, className }: FlowStripProps) {
  const valid =
    bracket !== undefined &&
    bracket.from >= 0 &&
    bracket.from <= bracket.to &&
    bracket.to < items.length;
  if (!valid) {
    return (
      <ol
        data-slot="flow-strip"
        className={cn('flex flex-wrap items-stretch gap-2 text-sm', className)}
      >
        {withArrows(items, 0)}
      </ol>
    );
  }
  const before = items.slice(0, bracket.from);
  const inside = items.slice(bracket.from, bracket.to + 1);
  const after = items.slice(bracket.to + 1);
  return (
    <ol
      data-slot="flow-strip"
      className={cn('flex flex-wrap items-stretch gap-2 text-sm', className)}
    >
      {withArrows(before, 0, bracket)}
      {before.length > 0 && <Arrow />}
      <li data-slot="flow-strip-group" className="flex min-w-0 flex-[2_1_20rem] flex-col gap-1.5">
        <ol className="flex flex-wrap items-stretch gap-2">
          {withArrows(inside, bracket.from, bracket)}
        </ol>
        <p
          data-slot="flow-strip-bracket"
          className="border-t-2 border-tone-info pt-1 font-mono text-[0.6875rem] tracking-wide text-tone-info uppercase"
        >
          {bracket.label}
        </p>
      </li>
      {after.length > 0 && <Arrow />}
      {withArrows(after, bracket.to + 1, bracket)}
    </ol>
  );
}
