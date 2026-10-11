import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PERSONAS } from '../../domain/personas.ts';
import { STAGE_COPY } from '../../domain/stages.ts';
import { STAGE_ORDER } from '../../domain/flow.ts';
import { formatCountdown } from '../../domain/format.ts';
import type { PersonaId, Session } from '../../domain/types.ts';
import { ledgerValue } from '../../test-support/ledger.ts';
import { ADMIN } from '../../test-support/fixtures.ts';
import { ConsentStep } from './consent-step.tsx';
import { PersonaStep } from './persona-step.tsx';
import { ProcessingStep } from './processing-step.tsx';
import { WalletStep } from './wallet-step.tsx';

describe('WalletStep', () => {
  it('asks which wallet should hold the tier and recommends the demo wallet', () => {
    render(<WalletStep onStart={vi.fn<() => void>()} disabledReason={null} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Which wallet should hold the tier?',
    );
    expect(screen.getByText('Demo wallet')).toBeInTheDocument();
    expect(screen.getByText('RECOMMENDED')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Network fees are paid by the demo relayer.')).toBeInTheDocument();
  });

  it('starts the flow from the button', () => {
    const onStart = vi.fn<() => void>();
    render(<WalletStep onStart={onStart} disabledReason={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start with a demo wallet' }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('disables the button and says why when the service is unavailable', () => {
    const onStart = vi.fn<() => void>();
    render(<WalletStep onStart={onStart} disabledReason="The gateway is down." />);
    const button = screen.getByRole('button', { name: 'Start with a demo wallet' });
    expect(button).toBeDisabled();
    expect(screen.getByText('The gateway is down.')).toBeInTheDocument();
    fireEvent.click(button);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('does not offer an own-wallet option', () => {
    render(<WalletStep onStart={vi.fn<() => void>()} disabledReason={null} />);
    expect(document.body).not.toHaveTextContent(/my own wallet|phantom|solflare|backpack/i);
  });
});

const setupPersona = (busy = false) => {
  const onBack = vi.fn<() => void>();
  const onChoose = vi.fn<(id: PersonaId) => void>();
  render(<PersonaStep onBack={onBack} onChoose={onChoose} busy={busy} />);
  return { onBack, onChoose };
};

describe('PersonaStep', () => {
  it('asks which bank account to check and lists the four accounts as radios', () => {
    setupPersona();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Which bank account should we check?',
    );
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    for (const persona of PERSONAS) {
      expect(
        screen.getByRole('radio', { name: new RegExp(persona.title, 'i') }),
      ).toBeInTheDocument();
      expect(screen.getByText(persona.description)).toBeInTheDocument();
    }
  });

  it('never shows the expected tier', () => {
    setupPersona();
    expect(document.body).not.toHaveTextContent(/\b(tier [ABC]|REJECT)\b/i);
  });

  it('keeps Request consent disabled until an account is chosen', () => {
    setupPersona();
    expect(screen.getByRole('button', { name: 'Request consent' })).toBeDisabled();
  });

  it('sends the chosen persona id', () => {
    const { onChoose } = setupPersona();
    fireEvent.click(screen.getByRole('radio', { name: /lumpy trader/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Request consent' }));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('trader_lumpy');
  });

  it('disables Request consent while busy', () => {
    setupPersona(true);
    fireEvent.click(screen.getByRole('radio', { name: /steady salary/i }));
    expect(screen.getByRole('button', { name: 'Request consent' })).toBeDisabled();
  });

  it('goes back', () => {
    const { onBack } = setupPersona();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe('ConsentStep', () => {
  const session: Session = {
    sessionId: 'sid',
    intent: 'TIO consent v1\nwallet: abc\nexpires: 123',
    intentExpires: 99n,
  };
  const setup = (secondsLeft = 581) => {
    const onApprove = vi.fn<() => void>();
    const onCancel = vi.fn<() => void>();
    render(
      <ConsentStep
        session={session}
        wallet={ADMIN}
        persona="salaried_steady"
        secondsLeft={secondsLeft}
        onApprove={onApprove}
        onCancel={onCancel}
      />,
    );
    return { onApprove, onCancel };
  };

  it('labels the consent request as simulated and lists what is shared', () => {
    setup();
    expect(screen.getByText('SIMULATED')).toBeInTheDocument();
    for (const label of [
      'Account',
      'Data',
      'Period',
      'Access',
      'Signed by',
      'Who reads it',
      "What's kept",
    ]) {
      expect(ledgerValue(label)).toBeTruthy();
    }
  });

  it('shows the intent verbatim and the countdown', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Approve with your wallet' })).toBeInTheDocument();
    expect(
      screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === session.intent),
    ).toBeInTheDocument();
    expect(screen.getByText(`expires in ${formatCountdown(581)}`)).toBeInTheDocument();
  });

  it('approves and cancels', () => {
    const { onApprove, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & sign' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('cannot approve once the countdown reaches zero', () => {
    const { onApprove } = setup(0);
    const button = screen.getByRole('button', { name: 'Approve & sign' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('explains the policy hash on demand', () => {
    setup();
    expect(screen.getByRole('button', { name: 'What is the policy hash?' })).toBeInTheDocument();
  });
});

const setupProcessing = (props: Partial<Parameters<typeof ProcessingStep>[0]> = {}) =>
  render(
    <ProcessingStep stages={[]} done={false} measurementId={3} verifyHref={null} {...props} />,
  );
const stageItem = (stage: (typeof STAGE_ORDER)[number]) => {
  const li = screen.getByText(STAGE_COPY[stage].title).closest('li');
  if (li === null) throw new Error('stage is not a list item');
  return li;
};
const isDone = (li: HTMLElement) =>
  li.getAttribute('data-state') === 'done' || /\(done\)/.test(li.textContent ?? '');

describe('ProcessingStep', () => {
  it('says it is checking the statement, then that the tier is on Solana', () => {
    const { unmount } = setupProcessing();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Checking your bank statement…',
    );
    unmount();
    setupProcessing({ stages: [...STAGE_ORDER], done: true });
    // The gateway reported a tier; the page doesn't say it's on Solana until it read it back.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'All stages done — reading your tier back from Solana…',
    );
  });

  it('names the registered enclave build', () => {
    setupProcessing();
    expect(screen.getByText('ENCLAVE BUILD #3 · REGISTERED ON SOLANA')).toBeInTheDocument();
  });

  it('claims no registration while the registry read has not confirmed the build', () => {
    setupProcessing({ measurementId: null });
    expect(screen.queryByText(/registered on solana/i)).not.toBeInTheDocument();
  });

  it('links Verify only when there is somewhere to verify', () => {
    const { unmount } = setupProcessing();
    expect(screen.queryByRole('link', { name: /verify/i })).not.toBeInTheDocument();
    unmount();
    setupProcessing({ verifyHref: '/verify?wallet=abc' });
    expect(screen.getByRole('link', { name: /verify/i })).toHaveAttribute(
      'href',
      '/verify?wallet=abc',
    );
  });

  it('lists the stages in a polite live region: earlier ones done, the newest one running', () => {
    // FORMATS §16 sends a stage event when the stage starts, so the newest one isn't done yet.
    setupProcessing({ stages: ['bind', 'fi_request'] });
    expect(stageItem('bind').closest('[aria-live="polite"]')).not.toBeNull();
    expect(isDone(stageItem('bind'))).toBe(true);
    expect(isDone(stageItem('fi_request'))).toBe(false);
    expect(stageItem('fi_request')).toHaveAttribute('data-state', 'current');
    expect(isDone(stageItem('fi_fetch'))).toBe(false);
    expect(isDone(stageItem('submit'))).toBe(false);
  });

  it('marks every stage done when finished', () => {
    setupProcessing({ stages: [...STAGE_ORDER], done: true });
    for (const stage of STAGE_ORDER) expect(isDone(stageItem(stage))).toBe(true);
  });

  it('draws where the data travels', () => {
    setupProcessing();
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});

describe('ProcessingStep while reading the tier back', () => {
  it('offers Start again once every stage ran, in case the tier never lands', () => {
    const onRestart = vi.fn<() => void>();
    setupProcessing({ stages: [...STAGE_ORDER], done: true, onRestart });
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('offers no Start again while the stages are still running', () => {
    setupProcessing({ stages: ['bind'], onRestart: vi.fn<() => void>() });
    expect(screen.queryByRole('button', { name: 'Start again' })).not.toBeInTheDocument();
  });
});
