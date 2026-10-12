import { useId } from 'react';
import { cn } from '@tio/ui/cn';
import { TONE_TEXT } from '@tio/ui/tokens';
import type { Book } from '../../domain/book.ts';
import { formatPercent, formatTokens } from '../../domain/format.ts';
import { tierTone } from '../../domain/tier-tone.ts';
import type { Tier } from '../../domain/types.ts';

export type TierMixProps = { mix: Book['tierMix'] };

const TIERS: readonly Tier[] = ['A', 'B', 'C'];

/** One bar split by principal per tier at borrow, and a legend with count and principal. */
export function TierMix({ mix }: TierMixProps) {
  const titleId = useId();
  const shown = TIERS.filter((tier) => mix[tier].shareBps > 0);
  const summary = TIERS.map((tier) => `tier ${tier} ${formatPercent(mix[tier].shareBps)}`).join(
    ', ',
  );
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <h2 id={titleId} className="font-display text-xl leading-tight">
        Tier mix by principal
      </h2>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open loans</p>
      ) : (
        <div
          role="img"
          aria-label={summary}
          className="flex h-3 w-full gap-px overflow-hidden rounded-sm border border-border"
        >
          {shown.map((tier) => (
            // Width only (never colour) inline: the share is data; colour comes from the token.
            <span
              key={tier}
              className={cn('h-full bg-current', TONE_TEXT[tierTone(tier)])}
              style={{ flexGrow: mix[tier].shareBps, flexBasis: 0 }}
            />
          ))}
        </div>
      )}
      <ul className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-sm">
        {TIERS.map((tier) => (
          <li key={tier} className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                'inline-block size-2.5 rounded-xs bg-current',
                TONE_TEXT[tierTone(tier)],
              )}
            />
            <span>{`${tier} · ${mix[tier].count} · ${formatTokens(mix[tier].principal)}`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
