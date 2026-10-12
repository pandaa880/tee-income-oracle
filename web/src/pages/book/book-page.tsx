// The loan book, one tab per pool: what a credit vehicle sees of the loans it funds. Chain only,
// read-only; `?pool=` picks the tab.
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tio/ui/tabs';
import { useConfig } from '../../app/use-config.ts';
import { shortAddress } from '../../domain/format.ts';
import { RoleStrip } from '../layout/role-strip.tsx';
import { BookPanel } from './book-panel.tsx';

const route = getRouteApi('/book');

/** Pool tabs as filled buttons (mockup board 10), not the ledger underline. */
const TAB =
  'mb-0 min-h-11 rounded-sm border border-border bg-card px-4 font-sans text-sm tracking-normal normal-case text-foreground data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:font-semibold data-[state=active]:text-primary-foreground';

export function BookPage() {
  const { pool: selected } = route.useSearch();
  const navigate = useNavigate();
  const { deployment } = useConfig();
  const current = deployment.pools.find((p) => p.poolId === selected) ?? deployment.pools[0];

  return (
    <main className="mx-auto flex max-w-(--content-max) flex-col gap-6 px-4 py-10">
      <Tabs
        value={String(selected)}
        onValueChange={(value) =>
          void navigate({ to: '/book', search: { pool: Number(value) === 1 ? 1 : 0 } })
        }
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex max-w-3xl flex-col gap-1.5">
            <TabsList aria-label="Pool" className="mb-2 flex-wrap gap-1.5 border-b-0">
              {deployment.pools.map((pool) => (
                <TabsTrigger key={pool.address} value={String(pool.poolId)} className={TAB}>
                  {`Pool ${pool.poolId}`}
                </TabsTrigger>
              ))}
            </TabsList>
            <h1 className="font-display text-2xl leading-[1.08] font-medium md:text-[2.75rem]">
              {`Pool ${current?.poolId ?? selected} · loan book`}
            </h1>
            <p className="text-muted-foreground">
              The view a credit vehicle gets of the loans it funds through an NBFC: every loan
              carries a verifiable attestation — which policy, which enclave build, how fresh. In
              this demo the pool plays both parts: it lends directly, where in production a
              regulated NBFC originates and disburses. Read-only, straight from chain.
            </p>
          </div>
          {current !== undefined && (
            <span className="font-mono text-sm text-muted-foreground">
              {`pool ${shortAddress(current.address)} · mint ${shortAddress(deployment.mint)}`}
            </span>
          )}
        </div>
        {deployment.pools.map((pool) => (
          <TabsContent
            key={pool.address}
            value={String(pool.poolId)}
            className="flex flex-col gap-6 pt-2"
          >
            <RoleStrip />
            {/* Only the selected tab's content mounts, so `selected` is this pool's id. */}
            <BookPanel pool={pool.address} poolId={selected} />
          </TabsContent>
        ))}
      </Tabs>
    </main>
  );
}
