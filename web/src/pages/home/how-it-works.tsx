import { Schematic } from '@tio/ui/schematic';
import { DATA_NODES } from '../../domain/stages.ts';

const STEPS = [
  [
    'Consent',
    'The borrower approves a one-time, view-only fetch through India’s Account Aggregator.',
  ],
  [
    'Verify blind',
    'The enclave checks the AA signature, decrypts, runs the pool’s eligibility criteria and wipes the data.',
  ],
  ['Attest', 'One tier, the policy hash and the enclave build are written to Solana.'],
  ['Lend', 'Pools read the tier inside their own instruction and lend within their own limits.'],
] as const;

/** At rest the drawing shows the whole path: every spoke in use, the relay and the enclave lit. */
const LIT = ['gateway', 'enclave'];
const SPOKES = DATA_NODES.filter((n) => n.slot !== 'center').map((n) => n.id);

export function HowItWorks() {
  return (
    <section className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-start">
      <div className="flex min-w-0 flex-col gap-5">
        <h2 className="font-display text-2xl leading-tight">From consent to loan in four steps</h2>
        <ol className="m-0 flex list-none flex-col border-t-3 border-double border-rule-strong p-0">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="flex gap-4 border-b border-border py-3.5">
              <span aria-hidden="true" className="min-w-6 font-mono text-sm text-muted-foreground">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span>
                <strong className="font-semibold">{title}.</strong> {body}
              </span>
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground">
          Your browser sees only the consent. The gateway relays ciphertext it can’t read. You trust
          AWS Nitro and the published code.
        </p>
      </div>
      <figure className="m-0 flex min-w-0 flex-col gap-2">
        <figcaption className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
          Fig. 1 — where the data travels
        </figcaption>
        <Schematic nodes={DATA_NODES} lit={LIT} spokes={SPOKES} />
      </figure>
    </section>
  );
}
