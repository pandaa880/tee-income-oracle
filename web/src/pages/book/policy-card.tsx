import { Card, CardContent, CardHeader } from '@tio/ui/card';
import { LedgerList, LedgerRow } from '@tio/ui/ledger';
import { POLICY_URL, PUBLISHED_POLICY_HASH } from '../../app/release.ts';
import { type Book, freshnessRules } from '../../domain/book.ts';
import { explorerAddressUrl } from '../../domain/explorer.ts';
import { formatTokens, shortHex } from '../../domain/format.ts';
import { ExternalLink } from '../layout/external-link.tsx';

export type PolicyCardProps = { policy: Book['policy']; cluster: string };

/** A zero limit means the pool doesn't lend to that tier. */
const limitText = (limit: bigint) => (limit === 0n ? 'not lent' : formatTokens(limit));

/** The funder's rules as the pool holds them on chain. */
export function PolicyCard({ policy, cluster }: PolicyCardProps) {
  const [a, b, c] = policy.tierLimits;
  // The link always goes to the published default; say whether this pool's hash is that file's.
  const published = policy.policyHashHex === PUBLISHED_POLICY_HASH;
  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-xl leading-tight">Policy (the funder’s rules)</h2>
      </CardHeader>
      <CardContent>
        <LedgerList>
          <LedgerRow
            label="Policy hash"
            mono
            value={
              <span className="inline-flex flex-wrap items-center justify-end gap-x-3">
                <span>{shortHex(policy.policyHashHex)}</span>
                <span className="font-sans text-xs text-muted-foreground">
                  {published ? 'published default' : 'not the published default'}
                </span>
                <ExternalLink href={POLICY_URL}>policy JSON</ExternalLink>
              </span>
            }
          />
          <LedgerRow
            label="Tier limits"
            mono
            value={`A ${limitText(a)} · B ${limitText(b)} · C ${limitText(c)}`}
          />
          <LedgerRow
            label="Freshness"
            value={
              <ul className="flex flex-col items-end">
                {freshnessRules(policy).map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            }
          />
          <LedgerRow
            label="Approved enclave builds"
            value={
              policy.approvedBuilds.length === 0 ? (
                'none'
              ) : (
                <span className="inline-flex flex-wrap justify-end gap-x-3">
                  {policy.approvedBuilds.map((build) => (
                    <ExternalLink
                      key={build.id}
                      href={explorerAddressUrl(cluster, build.entryAddress)}
                    >
                      {`#${build.id}`}
                    </ExternalLink>
                  ))}
                </span>
              )
            }
          />
        </LedgerList>
      </CardContent>
    </Card>
  );
}
