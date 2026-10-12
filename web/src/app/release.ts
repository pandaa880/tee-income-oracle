// The released version, from release-please's manifest, so the footer and proof bar follow releases.
import manifest from '../../../.release-please-manifest.json';
import publishedPolicyHash from '../../../test-vectors/policy/default.hash?raw';

export const RELEASE = `v${manifest['.']}`;

/** Where the published source lives; the proof bar and footer link to it. */
export const GITHUB_URL = 'https://github.com/pandaa880/tee-income-oracle';

/** Where pilot requests go for now: a prefilled issue on the repository (public). */
export const PILOT_REQUEST_URL = `${GITHUB_URL}/issues/new?title=${encodeURIComponent('Pilot request: <organisation>')}`;

/**
 * The published default policy at this release: the file the gateway sends and the demo pools
 * pin by hash. The page shows the pool's hash from chain; this is only where to read the rules.
 */
export const POLICY_URL = `${GITHUB_URL}/blob/${RELEASE}/test-vectors/policy/default.json`;

/** sha256 of that file's bytes (generated beside it): a pool pinning this hash runs those rules. */
export const PUBLISHED_POLICY_HASH = publishedPolicyHash.trim();
