import { Button } from '@tio/ui/button';
import { Input, Label } from '@tio/ui/input';
import { LedgerList, LedgerRow } from '@tio/ui/ledger';
import { useId, useState } from 'react';
import { formatAmount, parseAmount } from '../../domain/amount.ts';
import { messageFor } from '../../domain/errors.ts';
import { formatTokens } from '../../domain/format.ts';
import { borrowCeiling } from '../../domain/pool.ts';
import type { AppError, Tier } from '../../domain/types.ts';
import { ErrorCard } from '../borrow/error-card.tsx';

export type BorrowFormProps = {
  tier: Tier;
  /** This pool's limit for the tier, in base units. */
  limit: bigint;
  /** What the vault holds right now, in base units. */
  vault: bigint;
  pending: boolean;
  error: AppError | null;
  onBorrow: (amount: bigint) => void;
  /** Clears a failed attempt so the borrower can try again; no-op when the parent keeps none. */
  onDismissError?: () => void;
  onReattest?: () => void;
};

const noop = () => undefined;

export function BorrowForm(props: BorrowFormProps) {
  const { tier, limit, vault, pending, error, onBorrow } = props;
  const [text, setText] = useState('');
  const id = useId();
  const ceiling = borrowCeiling(limit, vault);
  const parsed = parseAmount(text, 6, ceiling);
  const label = pending
    ? 'Sending…'
    : parsed.ok
      ? `Borrow ${formatTokens(parsed.value)} tokens`
      : 'Borrow';
  const submit = () => {
    if (!parsed.ok || pending) return;
    onBorrow(parsed.value);
  };
  return (
    <section className="flex max-w-xl flex-col gap-5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase">
          Your limit · tier {tier}
        </span>
        <span className="font-display text-2xl">{formatTokens(limit)}</span>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>Amount</Label>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={pending}
          />
          <span className="text-sm text-muted-foreground">tokens</span>
          <Button
            variant="outline"
            onClick={() => setText(formatAmount(ceiling))}
            disabled={pending}
          >
            Max
          </Button>
        </div>
        {!parsed.ok && (
          <p className="text-sm text-muted-foreground">{messageFor(parsed.error).detail}</p>
        )}
      </div>
      <LedgerList>
        <LedgerRow label="Pool has available" value={formatTokens(vault)} />
        <LedgerRow label="Due date / fee" value="none in this demo pool (roadmap)" />
        <LedgerRow label="Network fees" value="paid by the demo relayer" />
      </LedgerList>
      <p className="text-sm text-muted-foreground">
        One transaction: creates your token account if you don't have one, then borrows. One open
        loan per wallet per pool.
      </p>
      <div>
        <Button onClick={submit} disabled={!parsed.ok || pending}>
          {label}
        </Button>
      </div>
      {error !== null && (
        <ErrorCard
          error={error}
          onRestart={props.onDismissError ?? noop}
          onRetry={props.onDismissError ?? noop}
          onReattest={props.onReattest ?? noop}
        />
      )}
    </section>
  );
}
