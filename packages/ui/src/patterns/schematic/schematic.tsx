import { cn } from '../../lib/cn.ts';

/** Node position in percent of the drawing (0..100 on both axes). */
export type SchematicNode = { id: string; label: string; x: number; y: number };
export type SchematicEdge = { from: string; to: string; active?: boolean };

export type SchematicProps = {
  nodes: readonly SchematicNode[];
  edges: readonly SchematicEdge[];
  /** Rendered size in px. The drawing is square; with neither set it fills its container's width. */
  width?: number;
  height?: number;
  className?: string;
};

/** Fixed coordinate system, so labels and dots keep their size relative to the drawing. */
const VIEWBOX = '0 0 100 100';

/**
 * Inked trust-path diagram: labelled dots at (x, y) percent, straight edges between them.
 * Active edges draw dashed in the primary colour.
 */
export function Schematic({ nodes, edges, width, height, className }: SchematicProps) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <svg
      data-slot="schematic"
      role="img"
      aria-label={nodes.map((n) => n.label).join(', ')}
      viewBox={VIEWBOX}
      {...(width === undefined ? {} : { width })}
      {...(height === undefined ? {} : { height })}
      className={cn(
        'font-mono text-foreground',
        width === undefined && height === undefined && 'h-auto w-full',
        className,
      )}
    >
      {edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (from === undefined || to === undefined) return null;
        const active = edge.active === true;
        return (
          <line
            key={`${edge.from}->${edge.to}`}
            data-slot="schematic-edge"
            data-active={active ? 'true' : 'false'}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="currentColor"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            className={active ? 'text-primary [stroke-dasharray:4_3]' : 'text-border'}
          />
        );
      })}
      {nodes.map((node) => (
        <g key={node.id} data-slot="schematic-node" transform={`translate(${node.x} ${node.y})`}>
          <circle r={1.5} fill="currentColor" />
          <text y={-3} textAnchor="middle" fontSize={4} fill="currentColor">
            {node.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
