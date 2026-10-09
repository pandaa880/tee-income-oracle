import { getRouteApi } from '@tanstack/react-router';
import { Stepper, type StepState } from '@tio/ui/stepper';
import { useBorrowFlow } from '../app/use-borrow-flow.ts';
import type { FlowState } from '../domain/flow.ts';

const route = getRouteApi('/borrow');

const STEPS = ['Wallet', 'Bank account', 'Consent', 'Processing', 'Result', 'Loan'] as const;

/** Where each flow step sits in the stepper (failed and rejected stop at their step). */
const POSITION: Record<FlowState['step'], number> = {
  wallet: 0,
  persona: 1,
  consent: 2,
  processing: 3,
  failed: 3,
  result: 4,
  rejected: 4,
  loan: 5,
};

function stepState(index: number, current: number): StepState {
  if (index < current) return 'done';
  return index === current ? 'current' : 'todo';
}

/** Placeholder until the borrow pages land: shows the chosen pool and the live flow position. */
export function BorrowPage() {
  const { pool } = route.useSearch();
  const { state } = useBorrowFlow();
  const current = POSITION[state.step];
  const steps = STEPS.map((label, i) => ({ label, state: stepState(i, current) }));
  return (
    <main className="mx-auto flex max-w-(--content-max) flex-col gap-8 px-4 py-12">
      <h1 className="font-display text-2xl leading-tight">Borrow</h1>
      <p className="text-muted-foreground">Pool {pool}</p>
      <Stepper steps={steps} />
    </main>
  );
}
