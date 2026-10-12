import { TONE_TEXT } from '@tio/ui/tokens';
import { useConfig } from '../../app/use-config.ts';
import { useStatus } from '../../app/use-status.ts';
import { statusLabel } from '../../domain/status.ts';

const CHECKING = 'CHECKING DEVNET STATUS…';
const UNKNOWN = 'The status check itself failed; the demo may or may not be up.';

/** Live / degraded / down, read from the gateway and the registry, never from this page. */
export function StatusStrip() {
  const status = useStatus();
  const { deployment } = useConfig();
  const label =
    status.data === undefined ? null : statusLabel(status.data, deployment.pools.length);
  const strip = label?.strip ?? (status.isError ? 'STATUS UNKNOWN' : CHECKING);
  const banner = label?.banner ?? (status.isError ? UNKNOWN : null);
  return (
    <div className="mx-auto flex max-w-(--content-max) flex-col gap-2 px-4">
      <p
        role="status"
        className="border-y border-border py-2 font-mono text-xs tracking-(--tracking-caps) text-muted-foreground uppercase"
      >
        {strip}
      </p>
      {banner !== null && (
        <p role="alert" className={`text-sm ${TONE_TEXT[label?.bannerTone ?? 'caution']}`}>
          {banner}
        </p>
      )}
    </div>
  );
}
