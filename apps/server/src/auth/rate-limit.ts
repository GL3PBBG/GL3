import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export const DEFAULT_RATE_LIMIT_PREFIX = "ratelimit";

export interface TokenBucketOptions {
  /** Bucket name, e.g. "login". */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Header carrying the real client IP (`config.clientIpHeader`). See `clientIp`. */
  ipHeader?: string | null | undefined;
}

/**
 * The client's IP for keying and telemetry. Behind Cloudflare (zero-trust
 * tunnel), `request.ip` is the tunnel/pod socket — one address for every
 * player — so buckets keyed on it collapse into a single shared bucket.
 * `CLIENT_IP_HEADER=cf-connecting-ip` names the header to trust instead.
 *
 * Trust is the OPERATOR's assertion, never auto-detected: honoring a
 * client-supplied header on a deployment whose origin is directly reachable
 * would let anyone forge their identity, so the fallback when the configured
 * header is absent or blank is the socket address, and no header is read at
 * all when none is configured.
 */
export function clientIp(request: Pick<FastifyRequest, "ip" | "headers">, headerName: string | null | undefined): string {
  if (!headerName) return request.ip;
  const raw = request.headers[headerName.toLowerCase()];
  const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
  return first ? first : request.ip;
}

// `prefix` defaults to the real "ratelimit" key space used in production —
// one Redis, one game, keys global by design. Tests share that same Redis
// instance across every file and worker, so bootTestServer() overrides this
// to a per-call random prefix (see server.ts), the same seam
// leaderboardPrefix already uses for the same reason.
export function tokenBucket(redis: Redis, opts: TokenBucketOptions, prefix = DEFAULT_RATE_LIMIT_PREFIX) {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const bucketKey = `${prefix}:${opts.name}:${clientIp(request, opts.ipHeader)}`;
    const hits = await countHit(redis, bucketKey, opts.windowSeconds);
    if (hits > opts.limit) {
      const ttl = await redis.ttl(bucketKey);
      reply.header("retry-after", String(Math.max(ttl, 1)));
      await reply.code(429).send({ error: "rate_limited" });
    }
  };
}

// SET ... NX EX creates the key and assigns its TTL as a single atomic op, so
// a crash or dropped connection between "key created" and "TTL assigned" can
// no longer leave a persistent, un-expiring key — which would otherwise
// rate-limit forever. INCR always runs after, so two racing requests both
// still count correctly even though only one of them wins the NX.
async function countHit(redis: Redis, key: string, windowSeconds: number): Promise<number> {
  await redis.set(key, "0", "EX", windowSeconds, "NX");
  return redis.incr(key);
}

/**
 * Same NX-EX-then-INCR shape as `tokenBucket`, but usable as a direct check
 * rather than a Fastify preHandler — for a limiter keyed on something only
 * known after the body is parsed (e.g. an email address), which can't be a
 * preHandler since Fastify hasn't parsed the body when preHandlers run.
 * Always counts the hit (so the caller can't be tricked into an unbounded
 * free check), and returns whether this hit was still within the limit.
 */
export async function withinRateLimit(
  redis: Redis, key: string, opts: { limit: number; windowSeconds: number },
): Promise<boolean> {
  const hits = await countHit(redis, key, opts.windowSeconds);
  return hits <= opts.limit;
}
