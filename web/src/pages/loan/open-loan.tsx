import type { Address } from '@solana/kit';
import type { Loan } from '@tio/demo-pool-client';
import { Button } from '@tio/ui/button';
import { LedgerList, LedgerRow } from '@tio/ui/ledger';
import { StatusBadge } from '@tio/ui/status-badge';
import { credentialLabel } from '../../domain/credential-copy.ts';
import { credentialTone } from '../../domain/credential-tone.ts';
import { type CredentialStatus, tierFromByte } from '../../domain/credential.ts';
import { explorerAddressUrl } from '../../domain/explorer.ts';
import { formatAge, formatTokens, formatUnixDateTime } from '../../domain/format.ts';
import type { AppError } from '../../domain/types.ts';
import { ErrorCard } from '../borrow/error-card.tsx';
import { ExternalLink } from '../layout/external-link.tsx';

export type OpenLoanProps = {
  loan: Loan;
  /** The credential as the pool sees it now (null if that read failed: repay doesn't need it). */
  status: CredentialStatus | null;
  pending: boolean;
  error: AppError | null;
  cluster: string;
  loanAddress: Address;
  onRepay: () => void;
  onDismissError?: () => void;
  onReattest?: () => void;
};

const noop = () => undefined;

export function OpenLoan(props: OpenLoanProps) {
  const { loan, status, pending, error, cluster, loanAddress, onRepay } = props;
  const amount = formatTokens(loan.amount);
  return (
    <section className="flex max-w-xl flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <h2 className="font-display text-xl leading-tight">Your open loan</h2>
        {status !== null && (
          <StatusBadge tone={credentialTone(status)} label={credentialLabel(status)} />
        )}
      </div>
      <LedgerList>
        <LedgerRow label="Principal" value={amount} strong />
        <LedgerRow label="Tier at borrow" value={tierFromByte(loan.tier) ?? `byte ${loan.tier}`} />
        <LedgerRow label="Borrowed" value={formatUnixDateTime(loan.borrowedAt)} />
        <LedgerRow
          label="Tier age at borrow"
          value={formatAge(loan.borrowedAt - loan.attestationIssuedAt)}
        />
      </LedgerList>
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={onRepay} disabled={pending}>
          {pending ? 'Sending…' : `Repay ${amount} tokens`}
        </Button>
        <ExternalLink href={explorerAddressUrl(cluster, loanAddress)} className="text-sm">
          Loan account
        </ExternalLink>
      </div>
      <p className="text-sm text-muted-foreground">
        Repay returns the full principal. The loan account deposit goes back to the relayer that
        paid it.
      </p>
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
