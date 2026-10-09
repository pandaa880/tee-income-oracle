import { Badge } from '../../primitives/badge/badge.tsx';
import type { Tone } from '../../tokens/tokens.ts';

export type StatusBadgeProps = { tone: Tone; label: string; className?: string };

/** Bordered mono chip for a state ("FRESH", "STALE", "OLD POLICY"). */
export function StatusBadge({ tone, label, className }: StatusBadgeProps) {
  return (
    <Badge
      data-slot="status-badge"
      variant="outline"
      tone={tone}
      {...(className === undefined ? {} : { className })}
    >
      {label}
    </Badge>
  );
}
