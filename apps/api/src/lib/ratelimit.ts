/**
 * In-process fixed-window rate limiter.
 *
 * Deliberately simple: the API runs as a single process per region in the
 * default deployment. A multi-instance deployment must swap this for a shared
 * store (see docs/ARCHITECTURE.md § scaling) — the interface is the same.
 */
export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string, cost = 1): RateLimitResult {
    const at = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      const fresh: Bucket = { count: cost, resetAt: at + this.windowMs };
      this.buckets.set(key, fresh);
      return { allowed: cost <= this.limit, remaining: Math.max(0, this.limit - cost), resetAt: fresh.resetAt };
    }
    bucket.count += cost;
    return {
      allowed: bucket.count <= this.limit,
      remaining: Math.max(0, this.limit - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  /** Drops expired buckets; called from the heartbeat loop. */
  prune(): void {
    const at = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= at) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
