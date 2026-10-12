import type { Config } from './config.ts';
import { type Deps, realDeps } from './deps.ts';

/** The parsed build-time config (deployment, feature flags, cluster). */
export function useConfig(deps: Deps = realDeps()): Config {
  return deps.config;
}
