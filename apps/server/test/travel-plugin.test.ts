import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import travelPlugin from "@gl3/plugin-travel";
import { PluginError } from "@gl3/plugin-sdk";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { callPluginRoute } from "./helpers/plugin-route.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
const leaderboardPrefix = `travel-test-${uuidv7()}`;

let playerId: string;
let chicagoId: string;
let miamiId: string;

const travel = (toLocationId: string) =>
  callPluginRoute(travelPlugin, "POST", "/api/travel/:locationId", {
    db, redis, leaderboardPrefix, playerId, params: { locationId: toLocationId },
  });

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n });

  chicagoId = uuidv7();
  miamiId = uuidv7();
  await db.insert(locations).values([
    { id: chicagoId, name: "Chicago", travelCost: 100n, travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n },
    { id: miamiId, name: "Miami", travelCost: 250n, travelCooldownSeconds: 120, bulletStock: 300, bulletCost: 8n },
  ]);
  await redis.del(cooldownKey(playerId, "travel"));
});

afterAll(async () => {
  await redis.del(`${leaderboardPrefix}:cash`, `${leaderboardPrefix}:bank`, `${leaderboardPrefix}:exp`);
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("POST /api/travel/:locationId", () => {
  it("debits the fare, moves the player, and publishes player.travelled with a null fromLocationId the first time", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    // `game:events` is global across test files — filter on this test's actor
    // (CLAUDE.md rule 4).
    const received = awaitOwnEvent(subscriber, playerId);

    const result = await travel(chicagoId);
    expect(result).toEqual({ status: 200, body: { locationId: chicagoId, cash: "900" } });

    const event = await received;
    expect(event.type).toBe("player.travelled");
    if (event.type !== "player.travelled") throw new Error("unreachable");
    expect(event.fromLocationId).toBeNull();
    expect(event.toLocationId).toBe(chicagoId);
    expect(event.cost).toBe("100");
  });

  it("rejects travelling to the player's current location", async () => {
    await travel(chicagoId);
    await redis.del(cooldownKey(playerId, "travel"));
    await expect(travel(chicagoId)).rejects.toMatchObject({ code: "already_there", status: 409 });
  });

  it("rejects an unknown location", async () => {
    await expect(travel(uuidv7())).rejects.toMatchObject({ code: "location_not_found", status: 404 });
  });

  it("rejects a fare the player can't afford and leaves them in place", async () => {
    await db.update(playerStats).set({ cash: 50n }).where(eq(playerStats.playerId, playerId));
    await expect(travel(miamiId)).rejects.toMatchObject({ code: "insufficient_funds", status: 409 });

    const [row] = await db.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.locationId).toBeNull();
  });

  it("gates on the per-player travel cooldown and answers with a retry-after header", async () => {
    await travel(chicagoId);
    const err = await travel(miamiId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    if (!(err instanceof PluginError)) throw new Error("unreachable");
    expect(err.status).toBe(429);
    expect(err.code).toBe("on_cooldown");
    expect(Number(err.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("releases the cooldown when the travel itself fails, so a rejected trip does not strand the player", async () => {
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, playerId));
    await expect(travel(miamiId)).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(await redis.exists(cooldownKey(playerId, "travel"))).toBe(0);
  });
});

describe("GET /api/locations", () => {
  it("lists every location, marks the current one, and reports the live cooldown", async () => {
    const before = await callPluginRoute(travelPlugin, "GET", "/api/locations", {
      db, redis, leaderboardPrefix, playerId,
    });
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      locations: expect.arrayContaining([
        expect.objectContaining({ id: chicagoId, name: "Chicago", travelCost: "100", current: false, cooldownRemaining: 0 }),
      ]),
    });

    await travel(chicagoId);

    const after = await callPluginRoute(travelPlugin, "GET", "/api/locations", {
      db, redis, leaderboardPrefix, playerId,
    });
    const listed = (after.body as { locations: { id: string; current: boolean; cooldownRemaining: number }[] }).locations;
    expect(listed.find((l) => l.id === chicagoId)?.current).toBe(true);
    expect(listed.find((l) => l.id === chicagoId)?.cooldownRemaining).toBeGreaterThan(0);
  });
});
