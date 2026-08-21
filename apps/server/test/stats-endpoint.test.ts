import { GameStatsResponseSchema } from "@gl3/shared";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

/** Must match `apps/server/src/stats/routes.ts`. */
const CACHE_KEY = "stats:game";

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  // The cache outlives `resetDb` — it is Redis, not Postgres — so an entry
  // left by an earlier run of this file would be served against a database
  // that no longer contains the rows it counted. Deleting this ONE key is
  // targeted; never FLUSH, the instance is shared with every other test file.
  await redis.del(CACHE_KEY);
});

afterAll(async () => { await closeServer(); await conn.end(); });

async function getStats(token: string) {
  return app.inject({
    method: "GET", url: "/api/stats", headers: { authorization: `Bearer ${token}` },
  });
}

describe("GET /api/stats", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(401);
  });

  it("answers a payload the shared schema accepts", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });

    const res = await getStats(token);
    expect(res.statusCode).toBe(200);

    const stats = GameStatsResponseSchema.parse(res.json());

    // Assert against the player this test just made, as a lower bound. An
    // exact global total would couple this file to whatever rows the boot
    // sequence and any future fixture happen to create, none of which this
    // route's correctness depends on.
    expect(stats.totals.playersTotal).toBeGreaterThanOrEqual(1);
    expect(stats.totals.jailedNow).toBeGreaterThanOrEqual(0);
    expect(stats.totals.hospitalisedNow).toBeGreaterThanOrEqual(0);
    expect(stats.totals.gangsTotal).toBeGreaterThanOrEqual(0);
    // Money crosses the wire as a decimal string, never a JSON number.
    expect(typeof stats.totals.moneySupply).toBe("string");
    expect(BigInt(stats.totals.moneySupply)).toBeGreaterThanOrEqual(0n);
  });

  it("returns fourteen index-aligned days ending today (UTC)", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });

    // Bracket the request: a run that straddles UTC midnight would otherwise
    // compare the server's "today" against a "today" that moved on after the
    // response — a real once-a-day flake, not a hypothetical one.
    const utcDayBefore = new Date().toISOString().slice(0, 10);
    const stats = GameStatsResponseSchema.parse((await getStats(token)).json());
    const utcDayAfter = new Date().toISOString().slice(0, 10);

    const { days, newPlayers, crimes, moneyMoved } = stats.trends;
    expect(days).toHaveLength(14);
    expect(newPlayers).toHaveLength(14);
    expect(crimes).toHaveLength(14);
    expect(moneyMoved).toHaveLength(14);

    expect([...days].sort()).toEqual(days);
    expect([utcDayBefore, utcDayAfter]).toContain(days[13]);

    // The player registered above was created just now, so the range is not
    // empty AND every joiner sits in the newest bucket — which is what proves
    // the SQL grouping lines up with the generated day list rather than
    // landing a day out. Allowing the second-newest bucket covers the same
    // midnight straddle bracketed above.
    const joined = newPlayers.reduce((sum, value) => sum + value, 0);
    expect(joined).toBeGreaterThanOrEqual(1);
    expect((newPlayers[13] ?? 0) + (newPlayers[12] ?? 0)).toBe(joined);
  });

  it("serves the second call inside the TTL from cache", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });

    const first = GameStatsResponseSchema.parse((await getStats(token)).json());

    // A player registered BETWEEN the two calls would change the payload if
    // it were recomputed — so an unchanged generatedAt is the cache, not a
    // coincidence of two fast reads landing in the same millisecond.
    await registerVerifiedPlayer({ app, redis });

    const second = GameStatsResponseSchema.parse((await getStats(token)).json());
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.totals.playersTotal).toBe(first.totals.playersTotal);
  });

  it("recomputes once the cached entry is gone", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const first = GameStatsResponseSchema.parse((await getStats(token)).json());

    await redis.del(CACHE_KEY);
    await registerVerifiedPlayer({ app, redis });

    const second = GameStatsResponseSchema.parse((await getStats(token)).json());
    expect(second.generatedAt).not.toBe(first.generatedAt);
    expect(second.totals.playersTotal).toBeGreaterThan(first.totals.playersTotal);
  });

  it("stores the cached payload under stats:game with a five-minute TTL", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    await getStats(token);

    const ttl = await redis.ttl(CACHE_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });
});
