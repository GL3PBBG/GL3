import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { players, playerStats } from "../src/db/schema/index.js";
import { PRESENCE_KEY, touchPresence } from "../src/presence/touch.js";
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

async function makePlayer(): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username: `pr-${id.slice(-8)}` });
  await db.insert(playerStats).values({ playerId: id });
  return id;
}

describe("touchPresence", () => {
  it("ZADDs the player and stamps last_seen_at once per window", async () => {
    const id = await makePlayer();
    const now = new Date();

    await touchPresence(redis, db, id, null, now);

    const score = await redis.zscore(PRESENCE_KEY, id);
    expect(score).not.toBeNull();
    expect(Number(score)).toBe(now.getTime());

    const [afterFirst] = await db.select({ lastSeenAt: players.lastSeenAt })
      .from(players).where(eq(players.id, id));
    expect(afterFirst?.lastSeenAt).not.toBeNull();
    const stampedAt = afterFirst?.lastSeenAt?.getTime();

    // Second call within the same 60s guard window: ZSET score moves, but the
    // DB stamp does not — the NX outcome on lastseenmark:<id> is the decision.
    const later = new Date(now.getTime() + 5000);
    await touchPresence(redis, db, id, null, later);

    const scoreAfterSecond = await redis.zscore(PRESENCE_KEY, id);
    expect(Number(scoreAfterSecond)).toBe(later.getTime());

    const [afterSecond] = await db.select({ lastSeenAt: players.lastSeenAt })
      .from(players).where(eq(players.id, id));
    expect(afterSecond?.lastSeenAt?.getTime()).toBe(stampedAt);
  });

  it("authenticated request touches presence", async () => {
    const { playerId, token } = await registerVerifiedPlayer({ app, redis });

    const res = await app.inject({
      method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    const score = await redis.zscore(PRESENCE_KEY, playerId);
    expect(score).not.toBeNull();
  });
});
