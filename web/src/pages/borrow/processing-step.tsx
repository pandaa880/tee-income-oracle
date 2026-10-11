import { Badge } from '@tio/ui/badge';
import { Button } from '@tio/ui/button';
import { Schematic } from '@tio/ui/schematic';
import { STAGE_ORDER } from '../../domain/flow.ts';
import { activeEdges, DATA_NODES, dataPath, STAGE_COPY } from '../../domain/stages.ts';
import type { Stage } from '../../domain/types.ts';

export type ProcessingStepProps = {
  /** Stages received so far, in order. */
  stages: readonly Stage[];
  /** Every stage ran; the page is reading the tier back from Solana before it shows it. */
  done: boolean;
  /** Offered while reading the tier back: if the reported attestation never lands, start over. */
  onRestart?: () => void;
  /** The gateway's enclave build, only once the registry read confirmed it (else no chip). */
  measurementId: number | null;
  /** Where to verify the build; null until the verify page ships. */
  verifyHref: string | null;
};

type StageState = 'done' | 'current' | 'todo';

function stageState(stage: Stage, stages: readonly Stage[], done: boolean): StageState {
  if (done || stages.includes(stage)) {
    // The latest stage is the one running now; everything before it has finished.
    return !done && stages.at(-1) === stage ? 'current' : 'done';
  }
  return 'todo';
}

const WHERE = [
  ['Browser', 'never'],
  ['Gateway', 'ciphertext only'],
  ['Enclave', 'in memory, then wiped'],
  ['Solana', 'tier + hashes'],
] as const;

/** Live stages as a ledger, plus the data path; the chip states a registry fact, not a verdict. */
export function ProcessingStep(props: ProcessingStepProps) {
  const { stages, done, measurementId, verifyHref, onRestart } = props;
  const current = stages.at(-1) ?? 'bind';
  const edges = activeEdges(current).map((e) => ({ ...e, active: true }));
  const path = dataPath(current);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-2xl leading-tight">
          {done
            ? 'All stages done — reading your tier back from Solana…'
            : 'Checking your bank statement…'}
        </h1>
        {done && onRestart !== undefined && (
          <div>
            <Button variant="outline" onClick={onRestart}>
              Start again
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {measurementId !== null && (
            <Badge variant="outline" tone="positive">
              {`ENCLAVE BUILD #${measurementId} · REGISTERED ON SOLANA`}
            </Badge>
          )}
          {verifyHref !== null && (
            <a href={verifyHref} className="text-sm underline underline-offset-4">
              Verify
            </a>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-start">
        <ol aria-live="polite" className="flex flex-col divide-y divide-border">
          {STAGE_ORDER.map((stage, i) => {
            const state = stageState(stage, stages, done);
            return (
              <li key={stage} data-state={state} className="flex gap-4 py-3">
                <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">
                  {state === 'done' ? '✓' : String(i + 1).padStart(2, '0')}
                </span>
                <span className="flex flex-col gap-1">
                  <span className={state === 'todo' ? 'text-muted-foreground' : 'font-medium'}>
                    {STAGE_COPY[stage].title}
                  </span>
                  {state !== 'todo' && (
                    <span className="text-sm text-muted-foreground">{STAGE_COPY[stage].note}</span>
                  )}
                  {state === 'done' && <span className="sr-only">(done)</span>}
                </span>
              </li>
            );
          })}
        </ol>
        <figure className="flex flex-col gap-3">
          <figcaption className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
            Fig. 1 — where your data travels
          </figcaption>
          <Schematic nodes={DATA_NODES} edges={edges} />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="font-mono tracking-(--tracking-caps) uppercase">Path</dt>
            <dd>{path.path}</dd>
            <dt className="font-mono tracking-(--tracking-caps) uppercase">Carries</dt>
            <dd>{path.carries}</dd>
          </dl>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
            <dt className="col-span-2 font-mono tracking-(--tracking-caps) text-muted-foreground uppercase">
              Where your bank data is
            </dt>
            {WHERE.map(([place, where]) => (
              <div key={place} className="col-span-2 grid grid-cols-subgrid">
                <dt className="font-medium">{place}</dt>
                <dd className="text-muted-foreground">{where}</dd>
              </div>
            ))}
          </dl>
        </figure>
      </div>
    </div>
  );
}
