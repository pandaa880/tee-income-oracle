// The real adapters, built once. Hooks default to `realDeps()`; tests pass fakes instead.
import { createChain } from '../adapters/rpc.ts';
import { createGateway } from '../adapters/gateway.ts';
import { createRelay } from '../adapters/relay.ts';
import { createStorage } from '../adapters/storage.ts';
import { demoWallet } from '../adapters/wallet-demo.ts';
import type {
  BorrowerSigner,
  ChainPort,
  GatewayPort,
  RelayPort,
  StoragePort,
} from '../domain/ports.ts';
import type { Config } from './config.ts';

export type Deps = {
  gateway: GatewayPort;
  relay: RelayPort;
  chain: ChainPort;
  storage: StoragePort;
  signer: BorrowerSigner;
  config: Config;
};

let built: Deps | undefined;

/**
 * Builds the adapters and restores the tab's demo wallet. `main.tsx` awaits this once before
 * the first render, because deriving the wallet key is async and hooks need deps synchronously.
 */
export async function initDeps(config: Config): Promise<Deps> {
  if (built !== undefined) return built;
  const storage = createStorage();
  built = {
    gateway: createGateway(config.gatewayUrl),
    relay: createRelay(config.gatewayUrl),
    chain: createChain(config.rpcUrl),
    storage,
    signer: await demoWallet(storage),
    config,
  };
  return built;
}

/** The deps `initDeps` built. Calling it before `initDeps` is a programming error. */
export function realDeps(): Deps {
  if (built === undefined) throw new Error('realDeps() called before initDeps()');
  return built;
}
