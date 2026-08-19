import { GameEventSchema, type GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, playerStats, settings } from "../src/db/schema/index.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { theftCars, theftGarage, theftTiers } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The two failure branches of `POST /api/theft/steal`, driven from settings
 * rather than from luck: `chase.escape_chance` is 100 or 0, and the tier's
 * `success_chance` is 0, so neither case depends on a roll.
 *
 * Settings are read into a boot-time snapshot (`settings/load.ts`), so each
 * case inserts its rows and then boots — a plain insert against an already
 * running app is invisible to it.
 */
const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
// A SEPARATE, ordinary client for registerVerifiedPlayer's Redis reads —
// `subscriber` enters Redis's dedicated subscriber mode once any test calls
// `subscriber.subscribe(...)`, after which no other command can run on it.
const redis = createRedis(loadConfig(process.env).redisUrl);

let app: FastifyInstance | undefined;
let closeServer: (() => Promise<void>) | undefined;
let regCounter = 0;

interface Fixture { token: string; playerId: string; tierId: string; locationId: string }

/** Wipes, seeds the given settings rows, boots, and lays out one thief. */
async function bootWith(rows: { key: string; value: string }[]): Promise<Fixture> {
  await resetDb(db);
  if (closeServer) await closeServer();
  await db.insert(settings).values(rows);
  ({ app, close: closeServer } = await bootTestServer());

  regCounter += 1;
  const { token, playerId } = await registerVerifiedPlayer({ app, redis }, {
    username: `Runner${regCounter}`,
    remoteAddress: `10.42.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });

  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `city-${locationId.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, playerId));

  // A car IS in the bracket: the chase must be reached because the theft
  // failed, never because the catalogue was empty.
  await db.insert(theftCars).values({ id: uuidv7(), name: "Sedan", value: 10_000n, theftWeight: 1 });
  const tierId = uuidv7();
  await db.insert(theftTiers).values({
    id: tierId, name: "Doomed", successChance: 0, maxDamage: 0,
    minCarValue: 1n, maxCarValue: 1_000_000n,
  });

  return { token, playerId, tierId, locationId };
}

/**
 * Collects every `game:events` frame naming `actorId`, in arrival order.
 *
 * `awaitOwnEvent` settles on the FIRST match and is used below to bound the
 * wait; the capture case needs the pair in order, and attaching a second
 * `awaitOwnEvent` after the first resolves would race the event that has
 * already been published. Same actorId filter, and for the same reason
 * (NOTES.md rule 4): `game:events` is one global channel and matching on
 * type alone captures another test file's traffic.
 */
function collectOwnEvents(actorId: string): { events: GameEvent[]; stop: () => void } {
  const events: GameEvent[] = [];
  const onMessage = (channel: string, raw: string): void => {
    if (channel !== GAME_EVENTS_CHANNEL) return;
    const parsed = GameEventSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.actorId === actorId) events.push(parsed.data);
  };
  subscriber.on("message", onMessage);
  return { events, stop: () => { subscriber.off("message", onMessage); } };
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

afterAll(async () => {
  if (closeServer) await closeServer();
  await conn.end();
  subscriber.disconnect();
  redis.disconnect();
});

describe("POST /api/theft/steal — the police chase", () => {
  it("lets the thief get away, jailing nobody and parking nothing", async () => {
    const fx = await bootWith([{ key: "theft.chase.escape_chance", value: "100" }]);
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const collector = collectOwnEvents(fx.playerId);
    const first = awaitOwnEvent(subscriber, fx.playerId);

    try {
      const res = await app!.inject({
        method: "POST",
        url: "/api/theft/steal",
        headers: { authorization: `Bearer ${fx.token}` },
        payload: { tierId: fx.tierId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: "escaped" });

      expect(await db.select().from(theftGarage).where(eq(theftGarage.playerId, fx.playerId)))
        .toHaveLength(0);
      const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, fx.playerId));
      expect(stats?.jailedUntil).toBeNull();

      const event = await first;
      expect(event).toMatchObject({ type: "plugin.event", pluginId: "theft", name: "resolved" });
      expect(event.type === "plugin.event" && event.payload).toMatchObject({
        outcome: "was spotted lifting a car and got away",
        success: "false",
      });

      // A getaway publishes ONE event: escaping is not a state change, so no
      // player.jailed follows it.
      await settle(250);
      expect(collector.events).toHaveLength(1);
    } finally {
      collector.stop();
    }
  });

  it("jails a caught thief and publishes theft.resolved before player.jailed", async () => {
    const fx = await bootWith([
      { key: "theft.chase.escape_chance", value: "0" },
      { key: "theft.chase.jail_seconds", value: "600" },
    ]);
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const collector = collectOwnEvents(fx.playerId);
    const first = awaitOwnEvent(subscriber, fx.playerId);

    try {
      const before = Date.now();
      const res = await app!.inject({
        method: "POST",
        url: "/api/theft/steal",
        headers: { authorization: `Bearer ${fx.token}` },
        payload: { tierId: fx.tierId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: "caught" });

      expect(await db.select().from(theftGarage).where(eq(theftGarage.playerId, fx.playerId)))
        .toHaveLength(0);

      const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, fx.playerId));
      expect(stats?.jailedUntil).not.toBeNull();
      // `before` is taken ahead of the request, so the deadline is 600s out
      // from a moment slightly LATER than it — hence a window, not equality.
      // Wide enough to survive a loaded box, narrow enough that the default
      // (600) could not be confused with any other value in this file.
      const seconds = (stats!.jailedUntil!.getTime() - before) / 1000;
      expect(seconds).toBeGreaterThan(590);
      expect(seconds).toBeLessThan(615);

      await first;
      // ORDER is the assertion: the module's own outcome first, the state
      // change second — the ordering game/crimes/worker.ts established, which
      // tx.events' single buffer preserves all the way to the wire.
      await settle(250);
      expect(collector.events.map((e) => e.type)).toEqual(["plugin.event", "player.jailed"]);
      const [resolved, jailed] = collector.events;
      expect(resolved).toMatchObject({ pluginId: "theft", name: "resolved" });
      expect(resolved?.type === "plugin.event" && resolved.payload).toMatchObject({
        outcome: "was caught lifting a car",
        success: "false",
      });
      expect(jailed).toMatchObject({ type: "player.jailed", reason: "caught stealing a car" });
    } finally {
      collector.stop();
    }
  });
});
