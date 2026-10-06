/**
 * DEMO keys for the live sandbox bank (FORMATS §2): the FIP and AA signing
 * keys. Unlike the test-vector keys they are never committed. The private
 * halves stay in `sandbox-bank/.secrets/` (gitignored); only the public
 * halves are pinned into the enclave image (`enclave/pinned/`).
 *
 * The private files carry no `private_key_test_only` flag, so the vector
 * loader refuses them, and their kids and moduli are fresh, so the
 * enclave's startup guard accepts them.
 */

import { generateRsaJwkPair } from '../crypto/rsa-jwk.ts';

export const DEMO_KEY_NAMES = ['aa', 'fip'] as const;

export interface DemoKeyFiles {
  /** File name in `.secrets/` → private JWK text. */
  readonly secrets: ReadonlyMap<string, string>;
  /** File name in `enclave/pinned/` → public JWK text. */
  readonly pinned: ReadonlyMap<string, string>;
}

/** Fresh demo key files. Random: run once, back the secrets up, commit the pinned halves. */
export function generateDemoKeyFiles(): DemoKeyFiles {
  const secrets = new Map<string, string>();
  const pinned = new Map<string, string>();
  for (const name of DEMO_KEY_NAMES) {
    const { privateJwk, publicJwk } = generateRsaJwkPair();
    secrets.set(`${name}.demo-private.jwk.json`, json(privateJwk));
    pinned.set(`${name}.jwk.json`, json(publicJwk));
  }
  return { secrets, pinned };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
