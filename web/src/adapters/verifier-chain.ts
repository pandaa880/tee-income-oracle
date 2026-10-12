// The verifier's view of the chain: raw accounts through the app's `ChainPort`, so its 429
// backoff, timeouts and the Query signal apply. A failed read throws the `AppError` as it is,
// so the page keeps "network busy" apart from "the verifier could not run".
import type { ChainReader } from '@tio/verifier/chain';
import type { ChainPort } from '../domain/ports.ts';

export function chainReader(chain: ChainPort, signal: AbortSignal): ChainReader {
  return {
    async account(address) {
      const read = await chain.rawAccounts([address], signal);
      if (!read.ok) throw read.error;
      return read.value[0] ?? null;
    },
  };
}
