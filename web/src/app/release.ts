// The released version, from release-please's manifest, so the footer and proof bar follow releases.
import manifest from '../../../.release-please-manifest.json';

export const RELEASE = `v${manifest['.']}`;

/** Where the published source lives; the proof bar and footer link to it. */
export const GITHUB_URL = 'https://github.com/pandaa880/tee-income-oracle';

/** Where pilot requests go for now: a prefilled issue on the repository (public). */
export const PILOT_REQUEST_URL = `${GITHUB_URL}/issues/new?title=${encodeURIComponent('Pilot request: <organisation>')}`;
