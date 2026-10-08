/**
 * Keeps the bank's copy of the enclave's FIU key current. The enclave makes a
 * new RSA FIU key at every boot (ARCHITECTURE §3) and signs its binding with
 * the attester key (FORMATS §8.1); the bank only trusts FI requests signed by
 * a registered key. Checked before every session: a new `kid` is
 * re-registered; a new attester means the enclave restarted under a new
 * registry entry, which needs ops (new `MEASUREMENT_ID`) before sessions work.
 */
import { gatewayError } from './errors.ts';
import type { BankClient, EnclaveClient } from './upstream.ts';

export type FiuKeyManager = {
  ensureFresh: () => Promise<void>;
  /** Forget the registration (the bank rejected our FIU signature). */
  markStale: () => void;
};

export function createFiuKeyManager(opts: {
  enclave: Pick<EnclaveClient, 'info'>;
  bank: Pick<BankClient, 'registerFiuKey'>;
  expectedAttester: string;
}): FiuKeyManager {
  const expected = opts.expectedAttester.toLowerCase();
  let registeredKid: string | undefined;

  return {
    async ensureFresh() {
      const info = await opts.enclave.info();
      if (info.attester_address.toLowerCase() !== expected) {
        throw gatewayError('enclave_rotated', 'enclave', 503);
      }
      const kid = info.fiu_public_jwk.kid;
      if (kid === registeredKid) return;
      await opts.bank.registerFiuKey({
        fiu_public_jwk: info.fiu_public_jwk,
        fiu_key_signature_hex: info.fiu_key_signature_hex,
      });
      registeredKid = kid;
    },
    markStale() {
      registeredKid = undefined;
    },
  };
}
