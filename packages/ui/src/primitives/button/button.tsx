import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

const buttonVariants = cva(
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md font-sans font-medium whitespace-nowrap transition-colors duration-(--dur-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-rule-strong bg-transparent text-foreground hover:bg-muted',
        ghost: 'bg-transparent text-foreground hover:bg-muted',
        link: 'min-h-0 bg-transparent text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'px-3 text-sm',
        md: 'px-4 text-md',
        lg: 'px-6 text-lg',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

/**
 * Action button; `asChild` styles a child element (e.g. a router link) instead. Defaults to
 * `type="button"` so it never submits a form by accident; a slotted child keeps its own type.
 */
export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="button"
      {...(asChild ? {} : { type: type ?? 'button' })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
