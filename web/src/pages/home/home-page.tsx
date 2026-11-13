import { GITHUB_URL, RELEASE } from '../../app/release.ts';
import { useConfig } from '../../app/use-config.ts';
import { useStatus } from '../../app/use-status.ts';
import { type ServiceStatus, registeredBuild, statusLabel } from '../../domain/status.ts';
import { StatusStrip } from '../layout/status-strip.tsx';
import { Compare } from './compare.tsx';
import { Hero } from './hero.tsx';
import { HowItWorks } from './how-it-works.tsx';
import { Market } from './market.tsx';
import { Pilot } from './pilot.tsx';
import { PoolSimulator } from './pool-simulator.tsx';
import { Problem } from './problem.tsx';
import { Solution } from './solution.tsx';
import { StatusChecklist } from './status-checklist.tsx';
import { Vision } from './vision.tsx';

/**
 * Every proof item is a system fact the reader can check; none is a testimonial. The build
 * number appears only once the registry read confirmed it; if the read says the build isn't
 * registered (down, revoked) or couldn't be read, the item is left out rather than contradicted.
 */
function proofItems(
  status: ServiceStatus | undefined,
  pending: boolean,
  live: boolean,
  verify: boolean,
) {
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
    ...(live ? [{ label: 'Live on Solana devnet' }] : []),
  ];
  return verify ? [...items, { label: 'Verify any tier yourself', href: '/verify' }] : items;
}

/**
 * The landing page as a pitch: the category line, the problem as a story, what TIO adds, the
 * bad-loan simulation and the example rules, how it compares, where the statement goes, what is
 * built and what isn't (with the checkable facts), the market, the vision and the pilot ask.
 * Reading only the headings gives the whole argument.
 */
export function HomePage() {
  const { features } = useConfig();
  const status = useStatus();
  const down = status.data?.state === 'down' ? statusLabel(status.data).banner : null;
  // One status-derived value for every "Live" claim on the page: only a read that says live.
  const live = status.data?.state === 'live';
  return (
    <>
      <StatusStrip />
      <main>
        <Hero ctaDisabledReason={down} live={live} />
        <Problem />
        <Solution />
        <PoolSimulator />
        <Compare />
        <HowItWorks />
        <StatusChecklist
          proofItems={proofItems(status.data, status.isPending, live, features.verify)}
          showBook={features.book}
        />
        <Market />
        <Vision />
        <Pilot ctaDisabledReason={down} />
      </main>
    </>
  );
}
