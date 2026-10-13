import { ProofBar } from '@tio/ui/proof-bar';
import { GITHUB_URL, RELEASE } from '../../app/release.ts';
import { useConfig } from '../../app/use-config.ts';
import { useStatus } from '../../app/use-status.ts';
import { type ServiceStatus, registeredBuild, statusLabel } from '../../domain/status.ts';
import { StatusStrip } from '../layout/status-strip.tsx';
import { Doors } from './doors.tsx';
import { FunderChecks } from './funder-checks.tsx';
import { Hero } from './hero.tsx';
import { HowItWorks } from './how-it-works.tsx';
import { Pilot } from './pilot.tsx';

/**
 * Every proof item is a system fact the reader can check; none is a testimonial. The build
 * number appears only once the registry read confirmed it; if the read says the build isn't
 * registered (down, revoked) or couldn't be read, the item is left out rather than contradicted.
 */
function proofItems(status: ServiceStatus | undefined, pending: boolean, verify: boolean) {
  const build = registeredBuild(status);
  const buildItem =
    build !== null
      ? [{ label: `Enclave build #${build} registered on Solana` }]
      : pending
        ? [{ label: 'Enclave build registered on Solana' }]
        : [];
  const items = [
    ...buildItem,
    { label: `Reproducible build, ${RELEASE}` },
    { label: 'Open source', href: GITHUB_URL },
    { label: 'Live on Solana devnet' },
  ];
  return verify ? [...items, { label: 'Verify any tier yourself', href: '/verify' }] : items;
}

/**
 * The landing page: the receipts thesis with an example receipt, the proof bar, what a funder can
 * check per loan, how it works, the two doors and the pilot ask.
 */
export function HomePage() {
  const { features } = useConfig();
  const status = useStatus();
  const down = status.data?.state === 'down' ? statusLabel(status.data).banner : null;
  return (
    <>
      <StatusStrip />
      <main>
        <Hero ctaDisabledReason={down} />
        <div className="mx-auto flex max-w-(--content-max) flex-col gap-16 px-4 py-16">
          <ProofBar items={proofItems(status.data, status.isPending, features.verify)} />
          <FunderChecks />
          <HowItWorks />
          <Doors features={features} />
        </div>
        <Pilot ctaDisabledReason={down} />
      </main>
    </>
  );
}
