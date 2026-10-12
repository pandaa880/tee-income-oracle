import { cn } from '../../lib/cn.ts';

/** Where a node sits on the plus-shaped drawing: the hub in the middle, one spoke on each side. */
export type SchematicSlot = 'top' | 'left' | 'center' | 'right' | 'bottom';

export type SchematicNode = {
  id: string;
  label: string;
  slot: SchematicSlot;
  /** One line under the label: what this node sees or does. */
  note?: string | undefined;
  /** Mono caps line above the label: the node's role. */
  kicker?: string | undefined;
  /** The trusted node, drawn with a double rule. */
  sealed?: boolean | undefined;
};

export type SchematicProps = {
  nodes: readonly SchematicNode[];
  /** Ids of the nodes drawn lit. */
  lit?: readonly string[];
  /** Ids of the outer nodes whose spoke to the hub is drawn lit. */
  spokes?: readonly string[];
  className?: string;
};

type Spoke = Exclude<SchematicSlot, 'center'>;

/** Grid cell of each slot on the 5 × 5 drawing (nodes on odd tracks, spokes between them). */
const CELL: Record<SchematicSlot, string> = {
  top: 'col-start-3 row-start-1',
  left: 'col-start-1 row-start-3',
  center: 'col-start-3 row-start-3',
  right: 'col-start-5 row-start-3',
  bottom: 'col-start-3 row-start-5',
};

/** The spoke between an outer slot and the hub sits in the track between them. */
const SPOKE: Record<Spoke, { cell: string; vertical: boolean }> = {
  top: { cell: 'col-start-3 row-start-2 w-0 justify-self-center', vertical: true },
  left: { cell: 'col-start-2 row-start-3 h-0 self-center', vertical: false },
  right: { cell: 'col-start-4 row-start-3 h-0 self-center', vertical: false },
  bottom: { cell: 'col-start-3 row-start-4 w-0 justify-self-center', vertical: true },
};

function nodeClass(node: SchematicNode, lit: boolean): string {
  if (node.sealed === true) {
    return cn(
      'border-3 border-double border-primary',
      lit ? 'bg-primary/10 text-foreground' : 'bg-card text-muted-foreground',
    );
  }
  return lit
    ? 'border-[1.5px] border-tone-info bg-tone-info/10 text-foreground'
    : 'border border-dashed border-muted-foreground/50 bg-card text-muted-foreground';
}

function spokeClass(vertical: boolean, lit: boolean): string {
  if (vertical) {
    return lit ? 'border-l-2 border-primary' : 'border-l border-dashed border-muted-foreground/50';
  }
  return lit ? 'border-t-2 border-primary' : 'border-t border-dashed border-muted-foreground/50';
}

/** What a screen reader hears for the whole drawing: each node with its note. */
function describe(nodes: readonly SchematicNode[]): string {
  return nodes.map((n) => (n.note === undefined ? n.label : `${n.label}: ${n.note}`)).join('; ');
}

/**
 * Trust-path diagram on a drafting grid: boxed nodes in a plus shape around a hub, joined by
 * straight spokes. Lit nodes and spokes show where the data is (or may go); the sealed node is
 * the trusted one.
 */
export function Schematic({ nodes, lit = [], spokes = [], className }: SchematicProps) {
  return (
    <div
      data-slot="schematic"
      role="img"
      aria-label={describe(nodes)}
      className={cn(
        'rounded-sm border border-border bg-card p-3 [background-image:var(--blueprint-grid)] [background-size:16px_16px] sm:p-6',
        className,
      )}
    >
      {/* Narrow spokes on phones leave the three columns of boxes room for their labels. */}
      <div className="grid grid-cols-[minmax(0,1fr)_1rem_minmax(0,1fr)_1rem_minmax(0,1fr)] grid-rows-[auto_1.5rem_auto_1.5rem_auto] text-xs sm:grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,1fr)_2.5rem_minmax(0,1fr)] sm:grid-rows-[auto_2rem_auto_2rem_auto]">
        {nodes.map((node) => {
          if (node.slot === 'center') return null;
          const spoke = SPOKE[node.slot];
          const on = spokes.includes(node.id);
          return (
            <span
              key={`spoke-${node.id}`}
              data-slot="schematic-edge"
              data-active={on ? 'true' : 'false'}
              className={cn(spoke.cell, spokeClass(spoke.vertical, on))}
            />
          );
        })}
        {nodes.map((node) => {
          const on = lit.includes(node.id);
          return (
            <div
              key={node.id}
              data-slot="schematic-node"
              data-lit={on ? 'true' : 'false'}
              className={cn(
                CELL[node.slot],
                'flex min-w-0 flex-col gap-px rounded-xs p-2.5 sm:p-3',
                nodeClass(node, on),
              )}
            >
              {node.kicker !== undefined && (
                <span className="font-mono text-[10px] tracking-(--tracking-caps) uppercase">
                  {node.kicker}
                </span>
              )}
              <strong className="text-sm font-semibold">{node.label}</strong>
              {node.note !== undefined && <span>{node.note}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
