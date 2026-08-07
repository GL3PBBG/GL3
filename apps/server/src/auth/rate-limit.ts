import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export const DEFAULT_RATE_LIMIT_PREFIX = "ratelimit";

export interface TokenBucketOptions {
  /** Bucket name, e.g. "login". */
  name: string;
  limit: number;
  windowSeconds: number;
}

// `prefix` defaults to the real "ratelimit" key space used in production —
// one Redis, one game, keys global by design. Tests share that same Redis
// instance across every file and worker, so bootTestServer() overrides this
// to a per-call random prefix (see server.ts), the same seam
// leaderboardPrefix already uses for the same reason.
export function tokenBucket(redis: Redis, opts: TokenBucketOptions, prefix = DEFAULT_RATE_LIMIT_PREFIX) {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const bucketKey = `${prefix}:${opts.name}:${request.ip}`;
    // SET ... NX EX creates the key and assigns its TTL as a single atomic
    // op, so a crash or dropped connection between "key created" and "TTL
    // assigned" can no longer leave a persistent, un-expiring key — which
    // would otherwise rate-limit that IP forever. INCR always runs after,
    // so two racing requests both still count correctly even though only
    // one of them wins the NX.
    await redis.set(bucketKey, "0", "EX", opts.windowSeconds, "NX");
    const hits = await redis.incr(bucketKey);
    if (hits > opts.limit) {
      const ttl = await redis.ttl(bucketKey);
      reply.header("retry-after", String(Math.max(ttl, 1)));
      await reply.code(429).send({ error: "rate_limited" });
    }
  };
}
