import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, players, playerStats } from "../src/db/schema/index.js";
import { PRESENCE_KEY } from "../src/presence/touch.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

async function makePlayer(username: string): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return id;
}

/** Puts the given players in one fresh location, stamped with `mode`. Modelled on location-combat-modes.test.ts's makeAttackable. */
async function makeTown(mode: "open" | "underground", ...playerIds: string[]): Promise<string> {
  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `town-${locationId.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
    combatMode: mode,
  });
  if (playerIds.length > 0) {
    await db.update(playerStats).set({ locationId }).where(inArray(playerStats.playerId, playerIds));
  }
  return locationId;
}

const getOnline = (token: string) =>
  app.inject({ method: "GET", url: "/api/online", headers: { authorization: `Bearer ${token}` } });

describe("GET /api/online", () => {
  it("splits 5-minute and 1-hour windows and trims older entries", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const a = await makePlayer("Al");
    const b = await makePlayer("Bo");
    const c = await makePlayer("Cy");
    const townId = await makeTown("open", a, b);

    const now = Date.now();
    await redis.zadd(PRESENCE_KEY, now, a);
    await redis.zadd(PRESENCE_KEY, now - 10 * 60 * 1000, b);
    await redis.zadd(PRESENCE_KEY, now - 2 * 60 * 60 * 1000, c);

    const res = await getOnline(token);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      onlineNow: { playerId: string; username: string; locationName: string | null }[];
      lastHour: { playerId: string; username: string; locationName: string | null }[];
    }>();

    expect(body.onlineNow.map((e) => e.playerId)).toContain(a);
    expect(body.onlineNow.map((e) => e.playerId)).not.toContain(b);
    expect(body.onlineNow.map((e) => e.playerId)).not.toContain(c);

    expect(body.lastHour.map((e) => e.playerId)).toContain(b);
    expect(body.lastHour.map((e) => e.playerId)).not.toContain(a);
    expect(body.lastHour.map((e) => e.playerId)).not.toContain(c);

    const onlineA = body.onlineNow.find((e) => e.playerId === a);
    const [town] = await db.select({ name: locations.name }).from(locations).where(eq(locations.id, townId));
    expect(onlineA?.locationName).toBe(town?.name);

    // The lazy trim runs on the read that just happened: C is more than an
    // hour stale and must be gone from the ZSET, A and B remain. PRESENCE_KEY
    // is a bare, unnamespaced key shared by every concurrently-running test
    // file (unlike leaderboardPrefix/rateLimitPrefix), so assert on these
    // players' own membership rather than a global ZCARD, which other files'
    // traffic would make flaky.
    expect(await redis.zscore(PRESENCE_KEY, c)).toBeNull();
    expect(await redis.zscore(PRESENCE_KEY, a)).not.toBeNull();
    expect(await redis.zscore(PRESENCE_KEY, b)).not.toBeNull();
  });

  it("conceals the town of a player standing in an underground location", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const a = await makePlayer("Overt");
    const b = await makePlayer("Covert");
    const openTown = await makeTown("open", a);
    await makeTown("underground", b);

    const now = Date.now();
    await redis.zadd(PRESENCE_KEY, now, a);
    await redis.zadd(PRESENCE_KEY, now, b);

    const res = await getOnline(token);
    const body = res.json<{ onlineNow: { playerId: string; locationName: string | null }[] }>();

    const [openTownRow] = await db.select({ name: locations.name }).from(locations).where(eq(locations.id, openTown));
    expect(body.onlineNow.find((e) => e.playerId === a)?.locationName).toBe(openTownRow?.name);
    expect(body.onlineNow.find((e) => e.playerId === b)?.locationName).toBeNull();
  });

  it("profile exposes lastSeenAt and the public route is rate-limited", async () => {
    const { playerId, token } = await registerVerifiedPlayer({ app, redis });
    // Any authenticated call stamps last_seen_at (see touch.ts).
    await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });

    const res = await app.inject({ method: "GET", url: `/api/players/${playerId}/profile` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ lastSeenAt: string | null }>().lastSeenAt).not.toBeNull();

    let last = res.statusCode;
    for (let i = 0; i < 61; i++) {
      const r = await app.inject({ method: "GET", url: `/api/players/${playerId}/profile` });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });
});
