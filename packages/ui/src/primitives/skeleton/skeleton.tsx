import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

/** Loading placeholder in the ruled-band colour. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-sm bg-muted motion-reduce:animate-none', className)}
      {...props}
    />
  );
}
