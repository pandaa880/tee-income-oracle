import { Badge } from '@tio/ui/badge';
import { type Capability, stageLabel, stageOf, stageTone } from '../../domain/roadmap.ts';

export type RoadmapBadgeProps = { capability: Capability };

/** How far along a capability is (from `domain/roadmap.ts`), as a small outlined chip in its tone. */
export function RoadmapBadge({ capability }: RoadmapBadgeProps) {
  const stage = stageOf(capability);
  return (
    <Badge variant="outline" tone={stageTone(stage)} className="shrink-0">
      {stageLabel(stage)}
    </Badge>
  );
}
