import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LedgerList, LedgerRow } from './ledger.tsx';

function renderRow(props: Partial<Parameters<typeof LedgerRow>[0]>) {
  return render(
    <LedgerList>
      <LedgerRow label="L" value="V" {...props} />
    </LedgerList>,
  );
}

describe('LedgerList', () => {
  it('renders a description list with term and definition per row', () => {
    const { container } = render(
      <LedgerList className="list-x">
        <LedgerRow label="Tier" value="A" />
        <LedgerRow label="Limit" value="1,000" />
      </LedgerList>,
    );
    const dl = container.querySelector('dl');
    expect(dl).toHaveClass('list-x');
    expect(screen.getByText('Tier').tagName).toBe('DT');
    expect(screen.getByText('A').tagName).toBe('DD');
    expect(container.querySelectorAll('dt')).toHaveLength(2);
    expect(container.querySelectorAll('dd')).toHaveLength(2);
  });
});

describe('LedgerRow', () => {
  it('styles a strong row differently from a plain row', () => {
    const { container: plain } = renderRow({});
    const plainCls = plain.querySelector('[data-slot="ledger-row"]')?.className;
    const { container: strong } = renderRow({ strong: true });
    const strongCls = strong.querySelector('[data-slot="ledger-row"]')?.className;
    expect(plainCls).toBeDefined();
    expect(strongCls).not.toBe(plainCls);
  });

  it('styles a mono value differently from a plain value', () => {
    const { unmount } = renderRow({});
    const plainCls = screen.getByText('V').className;
    unmount();
    renderRow({ mono: true });
    expect(screen.getByText('V').className).not.toBe(plainCls);
  });

  it('exposes tone as data-tone on the row', () => {
    const { container } = renderRow({ tone: 'positive' });
    expect(container.querySelector('[data-slot="ledger-row"]')).toHaveAttribute(
      'data-tone',
      'positive',
    );
  });

  it('accepts a ReactNode value', () => {
    renderRow({ value: <a href="/x">link</a> });
    expect(screen.getByRole('link', { name: 'link' })).toBeInTheDocument();
  });
});
