import { afterAll, beforeEach } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createRedis } from "../../src/redis.js";

/**
 * POST /api/auth/register and /api/auth/login are rate-limited per IP,
 * keyed `ratelimit:register:<ip>` / `ratelimit:login:<ip>` in Redis (see
 * src/auth/rate-limit.ts). Redis is one shared instance across every test
 * file — and, via Fastify's inject(), most files share the same default
 * 127.0.0.1 remoteAddress — so registrations accumulate across tests and
 * files until the real bucket trips a 429 that looks like an auth bug but
 * isn't.
 *
 * This is a Vitest `setupFile`, so it applies automatically to every test in
 * every file in this project: no test file needs to remember to clear its
 * own buckets, or invent a distinct remoteAddress to dodge the shared one.
 * rate-limit.test.ts exercises the limiter itself (counting, TTL, 429)
 * against dedicated randomly-named buckets, so clearing the real
 * register/login buckets here never touches its coverage.
 */

const redis = createRedis(loadConfig(process.env).redisUrl);

async function clearAuthRateLimitBuckets(): Promise<void> {
  const keys: string[] = [];
  for (const pattern of ["ratelimit:register:*", "ratelimit:login:*"]) {
    let cursor = "0";
    do {
      const [next, found] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      keys.push(...found);
    } while (cursor !== "0");
  }
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(clearAuthRateLimitBuckets);

afterAll(() => {
  redis.disconnect();
});
