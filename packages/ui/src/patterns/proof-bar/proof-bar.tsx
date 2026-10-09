import { cn } from '../../lib/cn.ts';

export type ProofBarProps = {
  items: readonly { label: string; href?: string }[];
  className?: string;
};

/** A row of checkable facts; items with an `href` link out to the evidence. Labels must be unique. */
export function ProofBar({ items, className }: ProofBarProps) {
  return (
    <ul
      data-slot="proof-bar"
      className={cn(
        'flex flex-wrap gap-x-6 gap-y-2 border-y border-border py-3 font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase',
        className,
      )}
    >
      {items.map((item) => (
        <li key={item.label}>
          {item.href === undefined ? (
            item.label
          ) : (
            <a
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-primary"
            >
              {item.label}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
