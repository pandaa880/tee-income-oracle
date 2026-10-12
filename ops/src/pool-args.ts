/**
 * `pool:setup` arguments beyond `--cluster`: which pool and its tier limits.
 * Parsed before any RPC so a typo fails fast and sends nothing.
 */
import { OpsError } from './errors.ts';
import { ONE_TOKEN, POOL_DEFAULTS } from './pool-setup.ts';

const POOL_ID_MAX = 255;
const U64_MAX = 2n ** 64n - 1n;
const WHOLE_NUMBER = /^\d+$/;

/** `--pool-id`: an integer 0..255 (the `u8` seed of the pool PDA); default 0. */
export function parsePoolId(raw: string | undefined): number {
  if (raw === undefined) return POOL_DEFAULTS.poolId;
  if (!WHOLE_NUMBER.test(raw) || Number(raw) > POOL_ID_MAX) {
    throw new OpsError('invalid_pool_id', '--pool-id must be an integer 0..255');
  }
  return Number(raw);
}

/**
 * `--tier-limits a,b,c` in whole tokens (6 decimals applied); default = pool 0's
 * values. Mirrors the program's `check_params`: `a > 0`, `a >= b`, `b >= c`
 * (a 0 limit means "tier not accepted").
 */
export function parseTierLimits(raw: string | undefined): readonly [bigint, bigint, bigint] {
  if (raw === undefined) return POOL_DEFAULTS.tierLimits;
  const [a, b, c, ...rest] = raw.split(',');
  if (a === undefined || b === undefined || c === undefined || rest.length !== 0) {
    throw invalidTierLimits('exactly three values');
  }
  if (![a, b, c].every((p) => WHOLE_NUMBER.test(p))) {
    throw invalidTierLimits('non-negative integers');
  }
  const limits = [BigInt(a) * ONE_TOKEN, BigInt(b) * ONE_TOKEN, BigInt(c) * ONE_TOKEN] as const;
  if (limits[0] > U64_MAX) throw invalidTierLimits('a within u64 base units');
  if (limits[0] === 0n) throw invalidTierLimits('a > 0');
  if (limits[0] < limits[1]) throw invalidTierLimits('a >= b');
  if (limits[1] < limits[2]) throw invalidTierLimits('b >= c');
  return limits;
}

const invalidTierLimits = (why: string): OpsError =>
  new OpsError('invalid_tier_limits', `--tier-limits must be a,b,c whole tokens with ${why}`);
