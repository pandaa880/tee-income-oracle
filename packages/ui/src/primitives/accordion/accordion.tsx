import { Accordion as AccordionPrimitive, Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

export function Accordion({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" className={cn(className)} {...props} />;
}

export function AccordionItem({
  className,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn('border-b border-border', className)}
      {...props}
    />
  );
}

/**
 * Question row with a "+" marker. `Slottable` keeps `asChild` working: the marker is placed
 * inside the slotted child instead of next to it (Slot accepts exactly one child).
 */
export function AccordionTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'group flex min-h-11 flex-1 items-center justify-between gap-4 py-3 text-left font-medium focus-visible:outline-2 focus-visible:outline-ring',
          className,
        )}
        {...props}
      >
        <Slot.Slottable>{children}</Slot.Slottable>
        <span
          aria-hidden="true"
          className="font-mono text-muted-foreground group-data-[state=open]:rotate-45 motion-safe:transition-transform"
        >
          +
        </span>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({
  className,
  children,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content data-slot="accordion-content" className="text-sm" {...props}>
      <div className={cn('pb-4 text-muted-foreground', className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}
