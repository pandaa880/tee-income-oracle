import { Button } from '@tio/ui/button';
import { LedgerList, LedgerRow } from '@tio/ui/ledger';
import { ProofBar } from '@tio/ui/proof-bar';
import { Schematic } from '@tio/ui/schematic';
import { Seal } from '@tio/ui/seal';
import { ThemeToggle } from '@tio/ui/theme-toggle';

export const GITHUB_URL = 'https://github.com/pandaa880/tee-income-oracle';

const PROOF = [
  { label: 'Reproducible enclave build' },
  { label: 'Runs on Solana devnet' },
  { label: 'Source on GitHub', href: GITHUB_URL },
];

const TRUST_PATH = {
  nodes: [
    { id: 'bank', label: 'Bank (AA)', x: 15, y: 50 },
    { id: 'enclave', label: 'Enclave', x: 50, y: 50 },
    { id: 'chain', label: 'Solana', x: 85, y: 50 },
  ],
  edges: [
    { from: 'bank', to: 'enclave', active: true },
    { from: 'enclave', to: 'chain', active: true },
  ],
};

/**
 * Placeholder home until the landing page and borrow flow land; composed only from @tio/ui.
 * The seal and ledger are a labelled example: nothing here is read from chain yet.
 */
export function HomePage() {
  return (
    <>
      <header className="mx-auto flex max-w-(--content-max) items-center justify-between px-4 pt-6">
        <span className="font-mono text-xs tracking-(--tracking-caps) uppercase">
          TEE Income Oracle · devnet
        </span>
        <ThemeToggle />
      </header>
      <main className="mx-auto flex max-w-(--content-max) flex-col gap-12 px-4 py-12">
        <section className="flex flex-col gap-6">
          <h1 className="font-display text-3xl leading-tight">
            Prove it blind. Show a tier, not the statement.
          </h1>
          <p className="max-w-prose text-lg text-muted-foreground">
            A bank statement is screened inside a hardware enclave. Only a tier and its proof fields
            reach Solana, where a lending pool reads them.
          </p>
          <div>
            <Button disabled>Borrow flow coming soon</Button>
          </div>
        </section>

        <ProofBar items={PROOF} />

        <section className="grid gap-8 md:grid-cols-2 md:items-center">
          <Schematic nodes={TRUST_PATH.nodes} edges={TRUST_PATH.edges} />
          <div className="flex flex-col items-start gap-6">
            <Seal tone="neutral" letter="A" label="Example" caption="Not a real result" />
            <LedgerList className="w-full">
              <LedgerRow label="Example tier" value="A" strong />
              <LedgerRow label="Policy" value="81112a23…932e1c" mono />
              <LedgerRow label="On chain" value="tier, ids, hashes, timestamps" />
            </LedgerList>
          </div>
        </section>
      </main>
    </>
  );
}
