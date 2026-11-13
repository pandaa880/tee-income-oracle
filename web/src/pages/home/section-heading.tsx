export type SectionHeadingProps = {
  /** Set on the `h2`, so the section can name itself with `aria-labelledby`. */
  id: string;
  /** The numbered label above the heading ("01 · The problem"). */
  kicker: string;
  /** A full-sentence claim: reading only the headings gives the whole pitch. */
  title: string;
};

/** A section's numbered kicker over its `h2`. */
export function SectionHeading({ id, kicker, title }: SectionHeadingProps) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-sm tracking-(--tracking-caps) text-muted-foreground uppercase">
        {kicker}
      </p>
      <h2
        id={id}
        className="max-w-3xl font-display text-2xl leading-tight text-balance md:text-[2.5rem]"
      >
        {title}
      </h2>
    </div>
  );
}
