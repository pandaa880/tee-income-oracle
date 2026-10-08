// Generate the oracle's TypeScript client from the Anchor IDL.
// Run after `anchor build`: pnpm --filter @tio/oracle-client generate
// Output in src/generated/ is committed; CI regenerates it and fails on any diff.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type AnchorIdl, rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

const idlPath = new URL('../../../../target/idl/oracle.json', import.meta.url);
const packageFolder = fileURLToPath(new URL('..', import.meta.url));

const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as AnchorIdl;
const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(
  renderVisitor(packageFolder, {
    // Keep package.json hand-written. The repo pins kit 7 (sas-lib 2.0 beta
    // needs it), and renderers-js 2.3.x is the last line that targets kit 7.
    // It emits extensionless imports and enums, so consumers use Bundler
    // resolution without erasableSyntaxOnly (see AGENTS.md → Gotchas).
    syncPackageJson: false,
    dependencyVersions: {
      '@solana/kit': '7.1.1',
      '@solana/program-client-core': '7.1.1',
    },
  }),
);
