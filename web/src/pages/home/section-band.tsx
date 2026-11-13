import { cn } from '@tio/ui/cn';
import type { ReactNode } from 'react';

export type SectionBandProps = {
  /** The id of the section's `h2`, which names the section for assistive tech. */
  labelledBy: string;
  /** Anchor target for in-page links (`#solution`). */
  id?: string;
  /** A full-width card-coloured band; the landing alternates plain and tinted sections. */
  tinted?: boolean;
  children: ReactNode;
};

/** One landing section: a full-width band holding a centred column. */
export function SectionBand({ labelledBy, id, tinted = false, children }: SectionBandProps) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn('scroll-mt-6', tinted && 'border-y border-border bg-card')}
    >
      <div className="mx-auto flex max-w-(--content-max) flex-col gap-8 px-4 py-16 md:py-20">
        {children}
      </div>
    </section>
  );
}
