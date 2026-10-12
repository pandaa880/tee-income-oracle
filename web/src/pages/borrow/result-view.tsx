import { Link } from '@tanstack/react-router';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@tio/ui/accordion';
import { Button } from '@tio/ui/button';
import { LedgerList, LedgerRow } from '@tio/ui/ledger';
import { Seal } from '@tio/ui/seal';
import { Skeleton } from '@tio/ui/skeleton';
import type { BorrowView, ChainRecord } from '../../domain/borrow-view.ts';
import { explorerAddressUrl, explorerTxUrl } from '../../domain/explorer.ts';
import {
  formatAge,
  formatTokens,
  formatUnixDate,
  formatUnixDateTime,
  hexOf,
  shortHex,
} from '../../domain/format.ts';
import { tierTone } from '../../domain/tier-tone.ts';
import { ExternalLink } from '../layout/external-link.tsx';

export type ResultViewProps = {
  /** Always backed by a chain read of this attestation (the view waits in `confirming` before). */
  result: Extract<BorrowView, { step: 'result' }>;
  /** Pools that accept this tier, with their limit; null while a pool's read is still catching up. */
  pools: readonly { poolId: number; limit: bigint }[] | null;
  /** Whether the tier matches what the chosen test account was built to score; null if unknown. */
  matchesPersona: boolean | null;
  cluster: string;
  verifyHref: string | null;
  /** The pool "Borrow now" opens: the one the flow was started for, else pool 0. */
  loanPool: 0 | 1;
  onReset: () => void;
};

function AcceptedLine({ pools }: { pools: ResultViewProps['pools'] }) {
  if (pools === null) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <span className="text-sm text-muted-foreground">Reading the pools’ limits…</span>
        <Skeleton className="h-6 w-2/3" />
      </div>
    );
  }
  if (pools.length === 0) return <p className="text-lg">No pool lends to this tier right now.</p>;
  const list = pools.map((p) => `Pool ${p.poolId} up to ${formatTokens(p.limit)}`).join(' · ');
  const noun = pools.length === 1 ? 'pool' : 'pools';
  return <p className="text-lg">{`Accepted by ${pools.length} ${noun}: ${list}`}</p>;
}

function RecordLedger({ record }: { record: ChainRecord }) {
  const { payload, expiry } = record;
  return (
    <LedgerList>
      <LedgerRow label="Issued" value={formatUnixDateTime(payload.issuedAt)} />
      <LedgerRow
        label="Expires"
        value={`${formatUnixDate(expiry)} · ${formatAge(expiry - payload.issuedAt)}`}
      />
      <LedgerRow label="Enclave build" value={`#${payload.measurementId}`} mono />
      <LedgerRow
        label="Policy"
        value={`${shortHex(hexOf(payload.policyHash))} · published default`}
        mono
      />
    </LedgerList>
  );
}

/** The 83 §7 bytes, field by field: tier, ids, hashes and timestamps, nothing personal. */
function StoredBytes({ record }: { record: ChainRecord }) {
  const { payload } = record;
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="bytes">
        <AccordionTrigger>What's stored on chain (83 bytes)</AccordionTrigger>
        <AccordionContent className="flex flex-col gap-3">
          <LedgerList>
            <LedgerRow label="tier" value={String(payload.tier)} mono />
            <LedgerRow label="proof_type" value={String(payload.proofType)} mono />
            <LedgerRow label="measurement_id" value={String(payload.measurementId)} mono />
            <LedgerRow label="policy_hash" value={hexOf(payload.policyHash)} mono />
            <LedgerRow label="consent_hash" value={hexOf(payload.consentHash)} mono />
            <LedgerRow label="issued_at" value={String(payload.issuedAt)} mono />
            <LedgerRow label="window" value={`${payload.windowFrom} → ${payload.windowTo}`} mono />
          </LedgerList>
          <p className="text-xs text-muted-foreground">
            No transactions or balances: only a tier and its proof fields, keyed to your wallet.
          </p>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function ResultView(props: ResultViewProps) {
  const { result, pools, matchesPersona, cluster, verifyHref, loanPool, onReset } = props;
  const { tier, attestation, tx, record, source } = result;
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-[auto_1fr] md:items-start">
      <Seal
        tone={tierTone(tier)}
        letter={tier}
        label="Attested"
        caption={`Build #${record.payload.measurementId}`}
      />
      <section className="flex min-w-0 flex-col gap-5">
        <h1 className="font-display text-3xl leading-tight">You're tier {tier}</h1>
        <AcceptedLine pools={pools} />
        <p className="text-muted-foreground">Show lenders this tier, not your statement.</p>
        {matchesPersona === true && (
          <p className="text-sm text-muted-foreground">
            Matches what this test account was built to score.
          </p>
        )}
        {source === 'chain' && (
          <p className="text-sm text-muted-foreground">
            Your wallet already holds a tier, read from Solana just now.
          </p>
        )}
        <RecordLedger record={record} />
        <p className="flex flex-wrap gap-x-4 text-sm">
          <ExternalLink href={explorerAddressUrl(cluster, attestation)}>
            Attestation on explorer
          </ExternalLink>
          {tx !== null && (
            <ExternalLink href={explorerTxUrl(cluster, tx)}>Transaction</ExternalLink>
          )}
          {verifyHref !== null && (
            <a
              href={verifyHref}
              className="inline-flex min-h-10 items-center underline underline-offset-4"
            >
              Anyone can check it: {verifyHref}
            </a>
          )}
        </p>
        <StoredBytes record={record} />
        <p className="max-w-prose text-sm text-muted-foreground">
          A tier is a policy-based affordability screen over one consented account, not a credit
          score. The demo pools run the published default policy. Every credit that didn't bounce
          counts, including transfers from your own accounts. It's a snapshot: it lasts 30 days, and
          a later rejection doesn't revoke it.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <Link to="/loan" search={{ pool: loanPool }}>
              Borrow now
            </Link>
          </Button>
          {source === 'chain' && (
            <Button variant="outline" onClick={onReset}>
              Attest again
            </Button>
          )}
          <span className="text-sm text-muted-foreground">
            Next in the loop: borrow, then repay.
          </span>
        </div>
      </section>
    </div>
  );
}
