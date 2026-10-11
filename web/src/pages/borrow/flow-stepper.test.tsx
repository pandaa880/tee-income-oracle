import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BorrowView } from '../../domain/borrow-view.ts';
import { decodePayload } from '@tio/oracle-client/attest';
import { ADMIN, NOW, OTHER, payloadBytes } from '../../test-support/fixtures.ts';
import { FlowStepper } from './flow-stepper.tsx';

const session = { sessionId: 's', intent: 'i', intentExpires: 9n };
const record = { payload: decodePayload(payloadBytes()), expiry: NOW };

const VIEWS: readonly (readonly [BorrowView, string])[] = [
  [{ step: 'wallet' }, 'Wallet'],
  [{ step: 'persona' }, 'Bank account'],
  [{ step: 'consent', session, persona: 'declining', wallet: ADMIN }, 'Consent'],
  [{ step: 'processing', stages: [] }, 'Processing'],
  [{ step: 'recovering' }, 'Processing'],
  [{ step: 'confirming', stages: [] }, 'Processing'],
  [{ step: 'failed', error: { code: 'tx_failed' } }, 'Processing'],
  [{ step: 'rejected' }, 'Result'],
  [{ step: 'result', source: 'stream', tier: 'A', attestation: OTHER, tx: null, record }, 'Result'],
];

describe('FlowStepper', () => {
  it('shows the five steps in order', () => {
    render(<FlowStepper view={{ step: 'wallet' }} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Wallet'),
      expect.stringContaining('Bank account'),
      expect.stringContaining('Consent'),
      expect.stringContaining('Processing'),
      expect.stringContaining('Result'),
    ]);
  });

  it.each(VIEWS.map(([view, label]) => [view.step, label, view] as const))(
    'the %s view marks %s current',
    (_, label, view) => {
      render(<FlowStepper view={view} />);
      expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent(label);
    },
  );
});
