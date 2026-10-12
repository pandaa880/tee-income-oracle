import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn('w-full border-collapse text-sm', className)}
        {...props}
      />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('border-b-3 border-double border-rule-strong', className)}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn(className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr data-slot="table-row" className={cn('border-b border-border', className)} {...props} />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'px-3 py-2 text-left font-mono text-xs font-medium tracking-(--tracking-caps) text-muted-foreground uppercase',
        className,
      )}
      {...props}
    />
  );
}

export type TableCellProps = ComponentProps<'td'> & { numeric?: boolean };

/** Body cell; `numeric` right-aligns in mono with tabular figures. */
export function TableCell({ className, numeric = false, ...props }: TableCellProps) {
  return (
    <td
      data-slot="table-cell"
      className={cn('px-3 py-2', numeric && 'text-right font-mono tabular-nums', className)}
      {...props}
    />
  );
}
