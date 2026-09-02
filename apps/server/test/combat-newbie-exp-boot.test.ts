import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats } from "../src/db/schema/index.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The newbie gate's EXP arm. combat.test.ts boots the default gl3 profile,
 * which is routed (progression claims exp, so `player_stats.exp` is
 * within-level and resets on every level-up) and therefore proves only the
 * LEVEL arm. This file pins `{ profile: "v2" }` — no exp claimant, GL3-native
 * rank thresholds — so `combat.newbie_exp_threshold` is what decides, and
 * `level` (0 for every native v2 player, US_rank for a migrated one) is
 * ignored entirely.
 */

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

let app: FastifyInstance;
let closeServer: () => Promise<void>;
let attackerToken: string;
let attackerId: string;
let targetId: string;

async function colocate(...ids: string[]): Promise<void> {
  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId, name: `loc-${locationId.slice(-8)}`,
    travelCost: 0n, travelCooldownSeconds: 60, bulletStock: 0, bulletCost: 1n,
  });
  await db.update(playerStats)
    .set({ locationId, exp: 100_000n, level: 0, bullets: 1000n, health: 100 })
    .where(inArray(playerStats.playerId, ids));
}

const attack = (id: string) =>
  app.inject({ method: "POST", url: `/api/combat/attack/${id}`, headers: { authorization: `Bearer ${attackerToken}` } });

beforeEach(async () => {
  await resetDb(db);
  // Explicit v2: the exp-threshold arm only exists on an unrouted boot.
  if (!app) ({ app, close: closeServer } = await bootTestServer({ profile: "v2" }));
  ({ token: attackerToken, playerId: attackerId } = await registerVerifiedPlayer({ app, redis }, { username: "Sal" }));
  ({ playerId: targetId } = await registerVerifiedPlayer({ app, redis }, { username: "Vito" }));
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("newbie protection on an unrouted (exp) boot", () => {
  it("clears at the exp threshold with level still 0", async () => {
    await colocate(attackerId, targetId);
    const res = await attack(targetId);
    expect(res.statusCode).toBe(200);
  });

  it("protects a target under the exp threshold whatever their level says", async () => {
    await colocate(attackerId, targetId);
    // A V2-migrated player carries US_rank in `level`; on an exp boot that
    // column is not the gate and must not clear it.
    await db.update(playerStats).set({ exp: 0n, level: 100 }).where(eq(playerStats.playerId, targetId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "protected" });
  });
});
