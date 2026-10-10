// The in-browser demo wallet: devnet only, one per tab. A fresh key also means the relayer
// funds its token account once (FORMATS §16: only addresses with no history are funded).
import {
  type KeyPairSigner,
  createKeyPairSignerFromPrivateKeyBytes,
  createSignableMessage,
  getBase16Codec,
} from '@solana/kit';
import type { BorrowerSigner, StoragePort } from '../domain/ports.ts';

const SEED_KEY = 'tio-demo-wallet-seed';
const SEED_HEX = /^[0-9a-f]{64}$/;
const hex = getBase16Codec();

function storedSeed(storage: StoragePort): Uint8Array | null {
  try {
    const value = storage.get(SEED_KEY);
    return value !== null && SEED_HEX.test(value) ? Uint8Array.from(hex.encode(value)) : null;
  } catch {
    return null;
  }
}

function newSeed(storage: StoragePort): Uint8Array {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  try {
    storage.set(SEED_KEY, hex.decode(seed));
  } catch {
    // Ephemeral: the wallet lasts as long as the page.
  }
  return seed;
}

function asBorrower(signer: KeyPairSigner): BorrowerSigner {
  return {
    address: signer.address,
    signer,
    async signIntent(bytes) {
      const [signatures] = await signer.signMessages([createSignableMessage(bytes)]);
      const signature = signatures?.[signer.address];
      if (signature === undefined) throw new Error('the demo wallet produced no signature');
      return signature;
    },
  };
}

/**
 * Restores the tab's wallet from its 32-byte seed, or creates one. The private key is
 * non-extractable; only the seed sits in sessionStorage, which ends with the tab.
 */
export async function demoWallet(storage: StoragePort): Promise<BorrowerSigner> {
  const seed = storedSeed(storage) ?? newSeed(storage);
  return asBorrower(await createKeyPairSignerFromPrivateKeyBytes(seed));
}
