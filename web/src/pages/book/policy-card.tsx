import { TONE_TEXT } from '@tio/ui/tokens';
import type { ReactNode } from 'react';
import { POLICY_URL, PUBLISHED_POLICY_HASH } from '../../app/release.ts';
import { type Book, freshnessRules } from '../../domain/book.ts';
import { explorerAddressUrl } from '../../domain/explorer.ts';
import { formatTokens, shortHex } from '../../domain/format.ts';
import { tierTone } from '../../domain/tier-tone.ts';
import type { Tier } from '../../domain/types.ts';
import { ExternalLink } from '../layout/external-link.tsx';

export type PolicyCardProps = { policy: Book['policy']; cluster: string };

const TIERS: readonly Tier[] = ['A', 'B', 'C'];

/** A zero limit means the pool doesn't lend to that tier. */
const limitText = (limit: bigint) => (limit === 0n ? 'not lent' : formatTokens(limit));

/** One cell of the policy grid: a small label over its value. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[0.8125rem] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** The funder's rules as the pool holds them on chain. */
export function PolicyCard({ policy, cluster }: PolicyCardProps) {
  // The link always goes to the published default; say whether this pool's hash is that file's.
  const published = policy.policyHashHex === PUBLISHED_POLICY_HASH;
  return (
    <section
      aria-label="Pool policy"
      className="grid grid-cols-1 gap-5 rounded-md border border-border bg-card px-6 py-5 sm:grid-cols-2 lg:grid-cols-4"
    >
      <Cell label="Policy (the funder’s rules)">
        <span className="font-mono text-sm break-all">{shortHex(policy.policyHashHex)}</span>
        <span className="text-xs text-muted-foreground">
          {published ? 'published default' : 'not the published default'}
        </span>
        <ExternalLink href={POLICY_URL} className="min-h-0 text-[0.8125rem]">
          policy JSON
        </ExternalLink>
      </Cell>
      <Cell label="Tier limits">
        <span className="text-sm">
          {TIERS.map((tier, i) => (
            <span key={tier}>
              {i > 0 && ' · '}
              <strong className={TONE_TEXT[tierTone(tier)]}>{tier}</strong>
              {` ${limitText(policy.tierLimits[i] ?? 0n)}`}
            </span>
          ))}
        </span>
      </Cell>
      <Cell label="Freshness">
        <span className="text-sm">
          {freshnessRules(policy).map((rule, i) => (
            <span key={rule}>
              {i > 0 && ' · '}
              <span>{rule}</span>
            </span>
          ))}
        </span>
      </Cell>
      <Cell label="Approved enclave builds">
        <span className="flex flex-wrap gap-x-3 text-sm">
          {policy.approvedBuilds.length === 0
            ? 'none'
            : policy.approvedBuilds.map((build) => (
                <ExternalLink
                  key={build.id}
                  href={explorerAddressUrl(cluster, build.entryAddress)}
                  className="min-h-0"
                >
                  {`#${build.id}`}
                </ExternalLink>
              ))}
        </span>
      </Cell>
    </section>
  );
}
