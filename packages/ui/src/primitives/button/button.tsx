import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { type ComponentProps, isValidElement, type ReactNode } from 'react';
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
 * A native `<button>` without a type submits its form. Whenever one gets rendered (ours, or a
 * slotted `<button>` child), default it to "button"; Slot lets the child's own `type` win.
 * Other slotted elements (links) get no type.
 */
function defaultType(asChild: boolean, children: ReactNode, type: ButtonProps['type']) {
  const rendersButton = !asChild || (isValidElement(children) && children.type === 'button');
  return rendersButton ? { type: type ?? 'button' } : {};
}

/** Action button; `asChild` styles a child element (e.g. a router link) instead. */
export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="button"
      {...defaultType(asChild, props.children, type)}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
