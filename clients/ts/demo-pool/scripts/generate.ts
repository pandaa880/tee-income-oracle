// Generate the demo pool's TypeScript client from the Anchor IDL.
// Run after `anchor build`: pnpm --filter @tio/demo-pool-client generate
// Output in src/generated/ is committed; CI regenerates it and fails on any diff.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type AnchorIdl, rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

const idlPath = new URL('../../../../target/idl/demo_pool.json', import.meta.url);
const packageFolder = fileURLToPath(new URL('..', import.meta.url));

const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as AnchorIdl;
const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(
  renderVisitor(packageFolder, {
    // Same settings as the oracle client (clients/ts/oracle/scripts/generate.ts):
    // hand-written package.json, kit 7 pinned (see AGENTS.md → Gotchas).
    syncPackageJson: false,
    dependencyVersions: {
      '@solana/kit': '7.1.1',
      '@solana/program-client-core': '7.1.1',
    },
  }),
);
