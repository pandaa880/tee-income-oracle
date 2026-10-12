import { Fragment } from 'react';
import { TONE_TEXT } from '@tio/ui/tokens';
import { useConfig } from '../../app/use-config.ts';
import { useStatus } from '../../app/use-status.ts';
import { type StatusLabel, statusLabel } from '../../domain/status.ts';

const CHECKING = 'CHECKING DEVNET STATUS…';
const UNKNOWN = 'The status check itself failed; the demo may or may not be up.';

/**
 * The state word in its tone, then the facts. The spaces between the items aren't drawn (flex
 * gap does that) but keep the live region's text readable as separate words.
 */
function StripItems({ label }: { label: StatusLabel }) {
  return (
    <>
      <span data-tone={label.stateTone} className={TONE_TEXT[label.stateTone]}>
        <span aria-hidden="true">●&nbsp;</span>
        {label.state}
      </span>
      {label.facts.map((fact) => (
        <Fragment key={fact}>
          {' '}
          <span>{fact}</span>
        </Fragment>
      ))}
    </>
  );
}

/**
 * Live / degraded / down, read from the gateway and the registry, never from this page. A
 * full-width ruled band under the header (mockup board 1b), its items on the page column.
 */
export function StatusStrip() {
  const status = useStatus();
  const { deployment } = useConfig();
  const label =
    status.data === undefined ? null : statusLabel(status.data, deployment.pools.length);
  const banner = label?.banner ?? (status.isError ? UNKNOWN : null);
  return (
    <>
      <div role="status" className="border-b border-border bg-muted py-1.5 sm:py-[0.4375rem]">
        <p className="mx-auto flex max-w-(--content-max) flex-wrap gap-x-3 gap-y-1 px-4 font-mono text-[0.65625rem] text-muted-foreground sm:gap-x-5 sm:text-xs">
          {label === null ? (
            <span>{status.isError ? 'STATUS UNKNOWN' : CHECKING}</span>
          ) : (
            <StripItems label={label} />
          )}
        </p>
      </div>
      {banner !== null && (
        <div className="mx-auto max-w-(--content-max) px-4 pt-3">
          <p role="alert" className={`text-sm ${TONE_TEXT[label?.bannerTone ?? 'caution']}`}>
            {banner}
          </p>
        </div>
      )}
    </>
  );
}
