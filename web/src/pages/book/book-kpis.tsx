import type { Book } from '../../domain/book.ts';
import { formatPercent, formatTokens } from '../../domain/format.ts';

export type BookKpisProps = { kpis: Book['kpis'] };

/** Four figures a funder reads first, each a label over its value. */
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
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex flex-col gap-1 rounded-sm border border-border p-4">
          <dt className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
            {tile.label}
          </dt>
          <dd className="font-display text-2xl leading-tight">{tile.value}</dd>
          {tile.note !== undefined && (
            <dd className="text-xs text-muted-foreground">{tile.note}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}
