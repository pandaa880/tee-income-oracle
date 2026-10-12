import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type SchematicNode, Schematic } from './schematic.tsx';

const NODES: SchematicNode[] = [
  { id: 'bank', label: 'Bank', slot: 'top', note: 'signs' },
  { id: 'hub', label: 'Gateway', slot: 'center', kicker: 'Relay' },
  { id: 'vault', label: 'Enclave', slot: 'right', note: 'plaintext only here', sealed: true },
  { id: 'chain', label: 'Chain', slot: 'bottom' },
];

function queryAll(container: HTMLElement, slot: string): Element[] {
  return Array.from(container.querySelectorAll(`[data-slot="${slot}"]`));
}

const attr = (elements: Element[], name: string) => elements.map((e) => e.getAttribute(name));

describe('Schematic', () => {
  it('is one image whose label reads every node with its note', () => {
    render(<Schematic nodes={NODES} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Bank: signs; Gateway; Enclave: plaintext only here; Chain',
    );
  });

  it('draws one box per node with its kicker, label and note', () => {
    const { container } = render(<Schematic nodes={NODES} />);
    expect(queryAll(container, 'schematic-node')).toHaveLength(4);
    for (const text of ['Bank', 'Gateway', 'Relay', 'Enclave', 'plaintext only here', 'Chain']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('places each node in its slot on the plus-shaped grid', () => {
    const { container } = render(<Schematic nodes={NODES} />);
    const [bank, hub, vault, chain] = queryAll(container, 'schematic-node');
    expect(bank).toHaveClass('col-start-3', 'row-start-1');
    expect(hub).toHaveClass('col-start-3', 'row-start-3');
    expect(vault).toHaveClass('col-start-5', 'row-start-3');
    expect(chain).toHaveClass('col-start-3', 'row-start-5');
  });

  it('draws one spoke per outer node, none for the hub', () => {
    const { container } = render(<Schematic nodes={NODES} />);
    expect(queryAll(container, 'schematic-edge')).toHaveLength(3);
  });

  it('lights only the listed nodes and spokes', () => {
    const { container } = render(
      <Schematic nodes={NODES} lit={['hub', 'vault']} spokes={['vault']} />,
    );
    expect(attr(queryAll(container, 'schematic-node'), 'data-lit')).toEqual([
      'false',
      'true',
      'true',
      'false',
    ]);
    expect(attr(queryAll(container, 'schematic-edge'), 'data-active')).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it('draws the sealed node with a double rule, lit or not', () => {
    const { container } = render(<Schematic nodes={NODES} />);
    const vault = queryAll(container, 'schematic-node')[2];
    expect(vault).toHaveClass('border-double');
    expect(queryAll(container, 'schematic-node')[0]).toHaveClass('border-dashed');
  });

  it('draws nothing for empty input', () => {
    const { container } = render(<Schematic nodes={[]} />);
    expect(queryAll(container, 'schematic-node')).toHaveLength(0);
    expect(queryAll(container, 'schematic-edge')).toHaveLength(0);
  });

  it('merges className onto the panel', () => {
    const { container } = render(<Schematic nodes={NODES} className="sch-x" />);
    expect(container.querySelector('[data-slot="schematic"]')).toHaveClass('sch-x');
  });
});
