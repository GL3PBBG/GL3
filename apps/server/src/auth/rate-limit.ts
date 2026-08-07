import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export interface TokenBucketOptions {
  /** Bucket name, e.g. "login". */
  name: string;
  limit: number;
  windowSeconds: number;
}

export function tokenBucket(redis: Redis, opts: TokenBucketOptions) {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const bucketKey = `ratelimit:${opts.name}:${request.ip}`;
    const hits = await redis.incr(bucketKey);
    if (hits === 1) await redis.expire(bucketKey, opts.windowSeconds);
    if (hits > opts.limit) {
      const ttl = await redis.ttl(bucketKey);
      reply.header("retry-after", String(Math.max(ttl, 1)));
      await reply.code(429).send({ error: "rate_limited" });
    }
  };
}
