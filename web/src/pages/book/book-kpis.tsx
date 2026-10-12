import type { Book } from '../../domain/book.ts';
import { formatPercent, formatTokens } from '../../domain/format.ts';

export type BookKpisProps = { kpis: Book['kpis'] };

/** Four figures a funder reads first, each a card with its label over its value. */
export function BookKpis({ kpis }: BookKpisProps) {
  const tiles = [
    { label: 'Principal outstanding', value: formatTokens(kpis.outstanding) },
    {
      label: 'Utilization',
      value: kpis.utilizationBps === null ? '—' : formatPercent(kpis.utilizationBps),
      note: 'outstanding ÷ (outstanding + vault)',
    },
    { label: 'Open loans', value: String(kpis.openLoans) },
    { label: 'In vault', value: formatTokens(kpis.vault) },
  ];
  return (
    <section aria-label="Key figures">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="flex flex-col gap-1 rounded-md border border-border bg-card px-5 py-4"
          >
            <dt className="text-[0.8125rem] text-muted-foreground">{tile.label}</dt>
            <dd className="font-mono text-[1.625rem] leading-tight font-medium">{tile.value}</dd>
            {tile.note !== undefined && (
              <dd className="text-xs text-muted-foreground">{tile.note}</dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}
