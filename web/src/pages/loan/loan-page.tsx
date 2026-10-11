// The loan screen reads chain only (credential, pool, vault, Loan PDA), so a reload or a returning
// wallet lands here with the right state; `?pool=` picks the tab.
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tio/ui/tabs';
import { useConfig } from '../../app/use-config.ts';
import { useCredentials } from '../../app/use-credential.ts';
import { useWallet } from '../../app/use-wallet.ts';
import { tierFromByte } from '../../domain/credential.ts';
import { poolLabel } from '../../domain/pool.ts';
import { PoolPanel } from './pool-panel.tsx';

const route = getRouteApi('/loan');

export function LoanPage() {
  const { pool: selected } = route.useSearch();
  const navigate = useNavigate();
  const { deployment } = useConfig();
  const { address: wallet } = useWallet();
  const credentials = useCredentials(
    wallet,
    deployment.pools.map((p) => p.address),
  );

  const label = (index: number) => {
    const pool = deployment.pools[index];
    const read = credentials[index]?.data;
    if (pool === undefined) return '';
    if (read === undefined) return `Pool ${pool.poolId}`;
    const tier = read.record === null ? null : tierFromByte(read.record.payload.tier);
    return poolLabel(pool.poolId, read.status, read.limit, tier);
  };

  return (
    <main className="mx-auto flex max-w-(--content-max) flex-col gap-8 px-4 py-12">
      <Tabs
        value={String(selected)}
        onValueChange={(value) =>
          void navigate({ to: '/loan', search: { pool: Number(value) === 1 ? 1 : 0 } })
        }
      >
        <TabsList>
          {deployment.pools.map((pool, i) => (
            <TabsTrigger key={pool.address} value={String(pool.poolId)}>
              {label(i)}
            </TabsTrigger>
          ))}
        </TabsList>
        {deployment.pools.map((pool) => (
          <TabsContent
            key={pool.address}
            value={String(pool.poolId)}
            className="flex flex-col gap-6 pt-6"
          >
            <h1 className="font-display text-2xl leading-tight">Pool {pool.poolId}</h1>
            <p className="max-w-prose text-muted-foreground">
              This pool stands in for an NBFC and the private-credit facility funding it. It reads
              your tier inside its own instruction: the check is on chain, not in this page.
            </p>
            <p className="max-w-prose text-sm text-tone-caution">
              Demo pool: it shows how the credential composes. Real Indian loans are disbursed by a
              regulated NBFC.
            </p>
            <PoolPanel pool={pool} wallet={wallet} />
          </TabsContent>
        ))}
      </Tabs>
    </main>
  );
}
