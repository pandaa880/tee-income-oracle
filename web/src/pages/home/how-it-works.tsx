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

/** Every hop the data takes, drawn once; the gateway in the middle carries what it can't read. */
const PATH_EDGES = [
  { from: 'browser', to: 'gateway' },
  { from: 'gateway', to: 'bank' },
  { from: 'bank', to: 'gateway', active: true },
  { from: 'gateway', to: 'enclave', active: true },
  { from: 'gateway', to: 'chain', active: true },
];

const CAPTIONS: Record<string, string> = {
  bank: 'encrypts · AA signs',
  browser: 'consent only',
  gateway: 'relays, can’t read',
  enclave: 'plaintext only here',
  chain: 'tier + hashes',
};

export function HowItWorks() {
  return (
    <section className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-start">
      <div className="flex flex-col gap-6">
        <h2 className="font-display text-2xl leading-tight">From consent to loan in four steps</h2>
        <ol className="flex list-decimal flex-col gap-4 pl-6 marker:font-mono marker:text-muted-foreground">
          {STEPS.map(([title, body]) => (
            <li key={title}>
              <span className="font-medium">{title}.</span> {body}
            </li>
          ))}
        </ol>
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p>Your browser sees only the consent.</p>
          <p>The gateway relays ciphertext it can’t read.</p>
          <p>You trust AWS Nitro and the published code.</p>
        </div>
      </div>
      <figure className="flex flex-col gap-3">
        <figcaption className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
          Fig. 1 — where the data travels
        </figcaption>
        <Schematic nodes={DATA_NODES} edges={PATH_EDGES} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
          {DATA_NODES.map((node) => (
            <div key={node.id} className="flex flex-col">
              <dt className="font-mono tracking-(--tracking-caps) uppercase">{node.label}</dt>
              <dd className="text-muted-foreground">{CAPTIONS[node.id]}</dd>
            </div>
          ))}
        </dl>
      </figure>
    </section>
  );
}
