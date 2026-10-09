import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

/** A clean sheet on paper: hairline border, no shadow. */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn('rounded-lg border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  );
}

export type CardHeaderProps = ComponentProps<'div'> & { rule?: 'hairline' | 'double' };

/** Card header; `rule="double"` closes it with the ledger's double rule. */
export function CardHeader({ className, rule = 'hairline', ...props }: CardHeaderProps) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'flex flex-col gap-1 p-6',
        rule === 'double'
          ? 'border-b-3 border-double border-rule-strong'
          : 'border-b border-border',
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return (
    <h3
      data-slot="card-title"
      className={cn('font-display text-xl leading-tight', className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('p-6', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center gap-2 border-t border-border p-6', className)}
      {...props}
    />
  );
}
