// The loan book, one tab per pool: what a credit vehicle sees of the loans it funds. Chain only,
// read-only; `?pool=` picks the tab.
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tio/ui/tabs';
import { useConfig } from '../../app/use-config.ts';
import { explorerAddressUrl } from '../../domain/explorer.ts';
import { shortAddress } from '../../domain/format.ts';
import { ExternalLink } from '../layout/external-link.tsx';
import { RoleStrip } from '../layout/role-strip.tsx';
import { BookPanel } from './book-panel.tsx';

const route = getRouteApi('/book');

export function BookPage() {
  const { pool: selected } = route.useSearch();
  const navigate = useNavigate();
  const { deployment, cluster } = useConfig();

  return (
    <main className="mx-auto flex max-w-(--content-max) flex-col gap-8 px-4 py-12">
      <Tabs
        value={String(selected)}
        onValueChange={(value) =>
          void navigate({ to: '/book', search: { pool: Number(value) === 1 ? 1 : 0 } })
        }
      >
        <TabsList>
          {deployment.pools.map((pool) => (
            <TabsTrigger key={pool.address} value={String(pool.poolId)}>
              {`Pool ${pool.poolId}`}
            </TabsTrigger>
          ))}
        </TabsList>
        {deployment.pools.map((pool) => (
          <TabsContent
            key={pool.address}
            value={String(pool.poolId)}
            className="flex flex-col gap-6 pt-6"
          >
            <h1 className="font-display text-2xl leading-tight">{`Pool ${pool.poolId} · loan book`}</h1>
            <p className="max-w-prose text-muted-foreground">
              The view a credit vehicle gets of the loans it funds through an NBFC: every loan
              carries a verifiable attestation — which policy, which enclave build, how fresh. In
              this demo the pool plays both parts: it lends directly, where in production a
              regulated NBFC originates and disburses. Read-only, straight from chain.
            </p>
            <p className="flex flex-wrap gap-x-4 font-mono text-sm text-muted-foreground">
              <ExternalLink href={explorerAddressUrl(cluster, pool.address)}>
                {`pool ${shortAddress(pool.address)}`}
              </ExternalLink>
              <ExternalLink href={explorerAddressUrl(cluster, deployment.mint)}>
                {`mint ${shortAddress(deployment.mint)}`}
              </ExternalLink>
            </p>
            <RoleStrip />
            <BookPanel pool={pool.address} />
          </TabsContent>
        ))}
      </Tabs>
    </main>
  );
}
