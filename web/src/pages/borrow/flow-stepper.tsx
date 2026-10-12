import { Stepper, type StepState } from '@tio/ui/stepper';
import type { BorrowView } from '../../domain/borrow-view.ts';

const STEPS = ['Wallet', 'Bank account', 'Consent', 'Processing', 'Result'] as const;

/** Where each view sits; a failure or a dropped stream stays on Processing. */
const POSITION: Record<BorrowView['step'], number> = {
  wallet: 0,
  persona: 1,
  consent: 2,
  processing: 3,
  confirming: 3,
  recovering: 3,
  failed: 3,
  result: 4,
  rejected: 4,
};

const stepState = (index: number, current: number): StepState =>
  index < current ? 'done' : index === current ? 'current' : 'todo';

export type FlowStepperProps = { view: BorrowView };

export function FlowStepper({ view }: FlowStepperProps) {
  const current = POSITION[view.step];
  return <Stepper steps={STEPS.map((label, i) => ({ label, state: stepState(i, current) }))} />;
}
