// The borrower flow: wallet → bank account → consent → processing → result. Hooks decide, this
// page composes. The flow state is corrected by the chain (a tier already there skips the flow).
import { getRouteApi } from '@tanstack/react-router';
import { Skeleton } from '@tio/ui/skeleton';
import { useState } from 'react';
import { useBorrowFlow } from '../../app/use-borrow-flow.ts';
import { useConfig } from '../../app/use-config.ts';
import { useCountdown } from '../../app/use-countdown.ts';
import { useCredentials } from '../../app/use-credential.ts';
import { useStatus } from '../../app/use-status.ts';
import { useWallet } from '../../app/use-wallet.ts';
import {
  acceptingPools,
  borrowView,
  confirmationEpoch,
  expireConsent,
  replacedAtStart,
  shouldPollCredential,
} from '../../domain/borrow-view.ts';
import { matchesExpected } from '../../domain/personas.ts';
import { registeredBuild, statusLabel } from '../../domain/status.ts';
import type { PersonaId } from '../../domain/types.ts';
import { ConsentStep } from './consent-step.tsx';
import { ErrorCard } from './error-card.tsx';
import { FlowStepper } from './flow-stepper.tsx';
import { PersonaStep } from './persona-step.tsx';
import { ProcessingStep } from './processing-step.tsx';
import { RecoveringCard } from './recovering-card.tsx';
import { RejectView } from './reject-view.tsx';
import { ResultView } from './result-view.tsx';
import { WalletStep } from './wallet-step.tsx';

/** Before the first step: does this wallet already hold a tier? */
function Checking() {
  return (
    <div className="flex max-w-xl flex-col gap-3" aria-busy="true">
      <p className="text-sm text-muted-foreground">Checking this wallet on Solana…</p>
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

const route = getRouteApi('/borrow');

export function BorrowPage() {
  const { pool: fromPool } = route.useSearch();
  const { address: wallet } = useWallet();
  const { deployment, cluster, features } = useConfig();
  const status = useStatus();
  const flow = useBorrowFlow();
  const { state } = flow;
  // The tier on chain when a flow starts (or the one "Attest again" replaces) must not stand in
  // for the new one.
  const [replacedIssuedAt, setReplacedIssuedAt] = useState<bigint | null>(null);
  const [chosen, setChosen] = useState<PersonaId | null>(null);
  const [busy, setBusy] = useState(false);

  const credentials = useCredentials(
    wallet,
    deployment.pools.map((p) => p.address),
    undefined,
    {
      epoch: confirmationEpoch(state),
      poll: (latest) =>
        shouldPollCredential({
          flow: state,
          credential: latest,
          attestation: latest?.attestation ?? null,
          replacedIssuedAt,
        }),
    },
  );
  const primary = credentials[0];
  const flowView = borrowView({
    flow: state,
    credential: primary?.data,
    attestation: primary?.data?.attestation ?? null,
    replacedIssuedAt,
  });
  const secondsLeft = useCountdown(
    flowView.step === 'consent' ? flowView.session.intentExpires : null,
  );
  const view = expireConsent(flowView, secondsLeft);

  const restart = () => {
    setChosen(null);
    flow.reset();
  };
  const attestAgain = () => {
    setReplacedIssuedAt(view.step === 'result' ? view.record.payload.issuedAt : null);
    restart();
  };
  const choose = async (id: PersonaId) => {
    setReplacedIssuedAt((current) => replacedAtStart(current, primary?.data));
    setChosen(id);
    setBusy(true);
    try {
      await flow.choosePersona(id);
    } finally {
      setBusy(false);
    }
  };

  const down = status.data?.state === 'down' ? statusLabel(status.data).banner : null;
  const verifyHref = features.verify ? `/verify?wallet=${wallet}` : null;
  const pools = acceptingPools(
    view,
    deployment.pools.map((p, i) => {
      const record = credentials[i]?.data;
      return record === undefined ? undefined : { poolId: p.poolId, record };
    }),
  );
  const checking = view.step === 'wallet' && primary?.isPending === true;

  return (
    <main className="mx-auto flex max-w-(--content-max) flex-col gap-10 px-4 py-12">
      <FlowStepper view={view} />
      {checking && <Checking />}
      {view.step === 'wallet' && !checking && (
        <WalletStep onStart={() => flow.connect()} disabledReason={down} />
      )}
      {view.step === 'persona' && (
        <PersonaStep onBack={restart} onChoose={(id) => void choose(id)} busy={busy} />
      )}
      {view.step === 'consent' && (
        <ConsentStep
          session={view.session}
          wallet={view.wallet}
          persona={view.persona}
          secondsLeft={secondsLeft}
          onApprove={() => void flow.confirmConsent()}
          onCancel={restart}
        />
      )}
      {(view.step === 'processing' || view.step === 'confirming') && (
        <ProcessingStep
          stages={view.stages}
          done={view.step === 'confirming'}
          measurementId={registeredBuild(status.data)}
          verifyHref={verifyHref}
          onRestart={restart}
        />
      )}
      {view.step === 'result' && (
        <ResultView
          result={view}
          pools={pools}
          matchesPersona={matchesExpected(chosen, view.tier)}
          cluster={cluster}
          verifyHref={verifyHref}
          loanPool={fromPool ?? 0}
          onReset={attestAgain}
        />
      )}
      {view.step === 'rejected' && <RejectView onReset={restart} />}
      {view.step === 'recovering' && <RecoveringCard onRestart={restart} />}
      {view.step === 'failed' && (
        <ErrorCard
          error={view.error}
          onRestart={restart}
          onRetry={restart}
          onReattest={restart}
          fallback="restart"
        />
      )}
    </main>
  );
}
