// The bytes the verify page checks: the archived attestation documents ship inside the app (the
// same build that bundles `deployments/devnet.json`, so the two cannot drift), and the compose
// file comes from the public repository at the build's release tag. Neither source is trusted;
// the checks are what make them count.
import { VerifierError } from '@tio/verifier/errors';
import { fetchComposeAtTag, parseHexDocument } from '@tio/verifier/sources';
import type { SourcesPort } from '../domain/ports.ts';

export const REPO = 'pandaa880/tee-income-oracle';

/**
 * Every archived document, by its path relative to this file; each loads as its own chunk. A
 * static map: the record's path is only a key into it, never resolved against the file system.
 */
const ARCHIVE = import.meta.glob<string>('../../../deployments/*/attestation-*.hex', {
  query: '?raw',
  import: 'default',
});

/** A fetch whose request stops when the caller's signal does, on top of the library's timeout. */
function fetchWithSignal(fetchFn: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => {
    const signals = [signal, ...(init?.signal ? [init.signal] : [])];
    return fetchFn(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

/** The chunk of one archived document; a tab on an older build than the server has gets `file_unreadable`. */
async function loadArchived(load: () => Promise<string>, file: string): Promise<string> {
  try {
    return await load();
  } catch {
    throw new VerifierError('file_unreadable', `archived document ${file} did not load`);
  }
}

/** Path → lazy loader of the file's text, as `import.meta.glob` builds it. */
export type Archive = Record<string, () => Promise<string>>;

export function createSources(
  fetchFn: typeof fetch = fetch,
  archive: Archive = ARCHIVE,
): SourcesPort {
  return {
    async archivedDocument(record) {
      const load = archive[`../../../deployments/${record.attestationFile}`];
      if (load === undefined) {
        throw new VerifierError(
          'deployment_malformed',
          `no archived document bundled for ${record.attestationFile}`,
        );
      }
      return parseHexDocument(await loadArchived(load, record.attestationFile));
    },
    async composeAtTag(record, signal) {
      if (record.release === undefined) {
        throw new VerifierError(
          'deployment_malformed',
          `record ${record.measurementId} names no release tag`,
        );
      }
      return fetchComposeAtTag(REPO, record.release, fetchWithSignal(fetchFn, signal));
    },
  };
}
