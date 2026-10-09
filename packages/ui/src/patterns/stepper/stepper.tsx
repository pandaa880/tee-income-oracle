import { cn } from '../../lib/cn.ts';

export type StepState = 'done' | 'current' | 'todo';

export type StepperProps = {
  steps: readonly { label: string; state: StepState }[];
  className?: string;
};

const STATE_CLASS: Record<StepState, string> = {
  done: 'text-muted-foreground',
  current: 'text-foreground border-b-2 border-rule-strong',
  todo: 'text-muted-foreground',
};

/**
 * Mono-caps step list; the current step carries `aria-current="step"`. Done steps show a
 * check instead of their number (not dimmed: dimming breaks contrast). Labels must be unique.
 */
export function Stepper({ steps, className }: StepperProps) {
  return (
    <ol
      data-slot="stepper"
      className={cn(
        'flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs tracking-(--tracking-caps) uppercase',
        className,
      )}
    >
      {steps.map((step, i) => (
        <li
          key={step.label}
          data-state={step.state}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className={cn('py-1', STATE_CLASS[step.state])}
        >
          <span aria-hidden="true">
            {step.state === 'done' ? '✓ ' : `${String(i + 1).padStart(2, '0')} `}
          </span>
          {step.label}
          {step.state === 'done' && <span className="sr-only"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}
