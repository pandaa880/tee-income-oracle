import { Button } from '@tio/ui/button';
import { useId, useState } from 'react';
import { PERSONAS } from '../../domain/personas.ts';
import type { PersonaId } from '../../domain/types.ts';

export type PersonaStepProps = {
  onBack: () => void;
  onChoose: (id: PersonaId) => void;
  /** A session is being created: no second request until it answers. */
  busy: boolean;
};

/** Four simulated accounts; the cards tell the story, never the tier they score. */
export function PersonaStep({ onBack, onChoose, busy }: PersonaStepProps) {
  const [chosen, setChosen] = useState<PersonaId | null>(null);
  const legend = useId();
  return (
    <section className="flex flex-col gap-6">
      <h1 className="font-display text-2xl leading-tight">Which bank account should we check?</h1>
      <p className="max-w-prose text-muted-foreground">
        Four simulated accounts with different income patterns: same flow, same policy, different
        tiers.
      </p>
      <p className="max-w-prose text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Simulated bank, real protocol.</span> These
        accounts live in a sandbox bank that speaks India’s Account Aggregator (ReBIT) format with
        demo keys. No real bank is contacted.
      </p>
      <fieldset className="flex flex-col gap-3">
        <legend
          id={legend}
          className="mb-3 font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase"
        >
          Bank account
        </legend>
        <div
          role="radiogroup"
          aria-labelledby={legend}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          {PERSONAS.map((persona) => (
            <label
              key={persona.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-4 has-checked:border-rule-strong"
            >
              <input
                type="radio"
                name="persona"
                value={persona.id}
                checked={chosen === persona.id}
                onChange={() => setChosen(persona.id)}
                className="mt-1 accent-primary"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{persona.title}</span>
                <span className="text-sm text-muted-foreground">{persona.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          disabled={chosen === null || busy}
          onClick={() => {
            if (chosen !== null) onChoose(chosen);
          }}
        >
          Request consent
        </Button>
      </div>
    </section>
  );
}
