import { afterAll, beforeEach } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createRedis } from "../../src/redis.js";

/**
 * POST /api/auth/register, /api/auth/login, /api/auth/verify and
 * /api/auth/verify/resend are rate-limited per IP, keyed
 * `<prefix>:register:<ip>` / `<prefix>:login:<ip>` / `<prefix>:verify:<ip>` /
 * `<prefix>:verifyresend:<ip>` in Redis, where
 * `<prefix>` is `ratelimit` in production and, for any server booted via
 * bootTestServer(), a random `ratelimit-test-<uuid>` assigned once in that
 * file's `beforeAll` (see server.ts) — the same fix, for the same reason, as
 * `queueName` and `leaderboardPrefix`: it stops two *different* test files
 * running concurrently from ever sharing a bucket, which is what used to
 * make this flaky under load.
 *
 * Namespacing per file does not remove the need to clear the bucket
 * *within* a file, though: bootTestServer() picks its prefix once and reuses
 * it for every test in that file, so a file whose `beforeEach` registers a
 * fresh player for every test (ws.test.ts, gang-invites.test.ts, ...) would
 * otherwise pile its own registrations onto its own bucket across the whole
 * file and legitimately trip the real 5-per-hour / 10-per-15-min limit
 * purely from its own traffic, a self-inflicted 429 that looks identical to
 * the auth bug it isn't. So this setupFile still clears before every test —
 * just against a wildcard prefix (`ratelimit*:...`) so it catches both the
 * literal production-shaped key (used directly by the handful of files that
 * call `buildApp()` without a `rateLimitPrefix`: bank/bullets/jail/
 * leaderboard/ranks/travel.test.ts) and every file's own namespaced one.
 * `verify`/`verifyresend` joined the sweep once `registerVerifiedPlayer`
 * (test/helpers/register.ts) made every test-helper registration also POST
 * /api/auth/verify: a file with more than ten registrations trips the real
 * 10-per-15-min verify limit purely from its own setup traffic otherwise.
 * `forgot`/`reset` joined the same way once auth-reset.test.ts started
 * calling POST /api/auth/forgot from every test in the file: it is limited
 * to 5/hour, well under what a handful of tests in one file legitimately
 * need.
 *
 * A sweep clearing another concurrently-running file's namespaced bucket in
 * the middle of its run is harmless — it only resets that file's own
 * counter early, which can never manufacture a false 429, only delay a real
 * one — and two different files can never corrupt *each other's* count,
 * because namespacing means they are never the same key to begin with.
 *
 * This is a Vitest `setupFile`, so it applies automatically to every test in
 * this project: no test file needs to remember to clear its own buckets, or
 * invent a distinct remoteAddress to dodge the shared one. rate-limit.test.ts
 * exercises the limiter itself (counting, TTL, 429) against dedicated
 * randomly-named buckets outside the `ratelimit` prefix entirely, so
 * clearing these buckets here never touches its coverage.
 */

const redis = createRedis(loadConfig(process.env).redisUrl);

async function clearAuthRateLimitBuckets(): Promise<void> {
  const keys: string[] = [];
  for (const pattern of ["ratelimit*:register:*", "ratelimit*:login:*", "ratelimit*:verify:*", "ratelimit*:verifyresend:*", "ratelimit*:forgot:*", "ratelimit*:reset:*"]) {
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
