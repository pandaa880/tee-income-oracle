import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Schematic } from './schematic.tsx';

const NODES = [
  { id: 'hub', label: 'Enclave', x: 50, y: 50 },
  { id: 'a', label: 'Bank', x: 10, y: 20 },
  { id: 'b', label: 'Chain', x: 90, y: 20 },
];
const EDGES = [
  { from: 'hub', to: 'a', active: true },
  { from: 'hub', to: 'b' },
];

function queryAll(container: HTMLElement, slot: string): Element[] {
  return Array.from(container.querySelectorAll(`[data-slot="${slot}"]`));
}

describe('Schematic', () => {
  it('renders an svg', () => {
    const { container } = render(<Schematic nodes={NODES} edges={EDGES} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('draws one element per node with its label', () => {
    const { container } = render(<Schematic nodes={NODES} edges={EDGES} />);
    expect(queryAll(container, 'schematic-node')).toHaveLength(3);
    for (const label of ['Enclave', 'Bank', 'Chain']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('draws one element per edge', () => {
    const { container } = render(<Schematic nodes={NODES} edges={EDGES} />);
    expect(queryAll(container, 'schematic-edge')).toHaveLength(2);
  });

  it('marks only active edges with data-active="true"', () => {
    const { container } = render(<Schematic nodes={NODES} edges={EDGES} />);
    const active = queryAll(container, 'schematic-edge').map((e) => e.getAttribute('data-active'));
    expect(active).toEqual(['true', 'false']);
  });

  it('draws no edges and no nodes for empty input', () => {
    const { container } = render(<Schematic nodes={[]} edges={[]} />);
    expect(queryAll(container, 'schematic-node')).toHaveLength(0);
    expect(queryAll(container, 'schematic-edge')).toHaveLength(0);
  });

  it('applies width and height to the svg', () => {
    const { container } = render(
      <Schematic nodes={NODES} edges={EDGES} width={400} height={200} />,
    );
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '400');
    expect(svg).toHaveAttribute('height', '200');
  });

  it('merges className', () => {
    const { container } = render(<Schematic nodes={NODES} edges={EDGES} className="sch-x" />);
    expect(container.querySelector('svg')).toHaveClass('sch-x');
  });

  it('keeps a fixed 0..100 viewBox and fills its container when no size is given', () => {
    const { container } = render(<Schematic nodes={NODES} edges={EDGES} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 100 100');
    expect(svg).not.toHaveAttribute('width');
    expect(svg).toHaveClass('w-full');
  });

  it('does not stretch to the container when a size is given', () => {
    const { container } = render(<Schematic nodes={NODES} edges={EDGES} height={200} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 100 100');
    expect(svg).not.toHaveClass('w-full');
  });
});
