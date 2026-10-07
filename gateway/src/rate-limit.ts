/**
 * Token-bucket rate limit for session creation: one bucket per client IP and
 * one global bucket. A request needs a token from both; a refusal by either
 * takes nothing from the other. It bounds consent issuance, enclave sessions
 * and relayer spend (ARCHITECTURE §5, FORMATS §15 deployment invariant).
 */

export type BucketConfig = { burst: number; perMinute: number };

type Bucket = { tokens: number; at: number };

export type RateLimiter = { allow: (ip: string) => boolean };

function refill(bucket: Bucket, config: BucketConfig, now: number): void {
  // Clamped: a wall-clock step backwards must not take tokens away.
  const earned = (Math.max(0, now - bucket.at) * config.perMinute) / 60_000;
  bucket.tokens = Math.min(config.burst, bucket.tokens + earned);
  bucket.at = now;
}

export function createRateLimiter(opts: {
  now: () => number;
  perIp?: BucketConfig;
  global?: BucketConfig;
  maxIps?: number;
}): RateLimiter {
  const {
    now,
    perIp = { burst: 5, perMinute: 10 },
    global = { burst: 20, perMinute: 60 },
    maxIps = 10_000,
  } = opts;
  const globalBucket: Bucket = { tokens: global.burst, at: now() };
  const ipBuckets = new Map<string, Bucket>();

  const bucketFor = (ip: string, t: number): Bucket => {
    const existing = ipBuckets.get(ip);
    if (existing !== undefined) return existing;
    // Bounded map: when full, forget every IP (a forgotten IP starts with a full
    // burst, which the global bucket still caps).
    if (ipBuckets.size >= maxIps) ipBuckets.clear();
    const fresh = { tokens: perIp.burst, at: t };
    ipBuckets.set(ip, fresh);
    return fresh;
  };

  return {
    allow(ip) {
      const t = now();
      const ipBucket = bucketFor(ip, t);
      refill(ipBucket, perIp, t);
      refill(globalBucket, global, t);
      if (ipBucket.tokens < 1 || globalBucket.tokens < 1) return false;
      ipBucket.tokens -= 1;
      globalBucket.tokens -= 1;
      return true;
    },
  };
}
