import type { ReactNode } from 'react';

export type ExternalLinkProps = { href: string; children: ReactNode; className?: string };

/** A new-tab link (explorer, source) with the ↗ cue; the arrow stays out of the link's name. */
export function ExternalLink({ href, children, className }: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-10 items-center underline underline-offset-4 ${className ?? ''}`}
    >
      {children}
      <span aria-hidden="true">&nbsp;↗</span>
    </a>
  );
}
