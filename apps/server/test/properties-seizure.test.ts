import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import propertiesPlugin, { propertiesTable } from "@gl3/plugin-properties";
import { killResolved } from "@gl3/plugin-combat";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, notifications, players, playerStats } from "../src/db/schema/index.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { resetDb, testDb } from "./helpers/db.js";

/**
 * This file drives the subscription directly through `ctx.filters.apply`,
 * exactly the way combat itself does after a real kill
 * (`packages/plugins/combat/src/index.ts`) — no bootTestServer, no HTTP, no
 * real attack. So nothing else applies the properties migrations first: the
 * template database every test file clones is built from CORE migrations
 * only. Pattern: apps/server/test/properties-pay-owner.test.ts.
 */
const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
const subscriber = createSubscriber(redisUrl);

const leaderboardPrefix = `properties-seizure-test-${uuidv7()}`;
const deps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix });
// pluginId "combat": production reality. It is combat's route that calls
// `ctx.filters.apply(killResolved, ...)` after a kill, and `runFilterChain`
// (SDK) hands a subscriber the APPLYING plugin's ctx — so the ctx a real
// seizeOnKill run sees always has pluginId "combat", never "properties".
const opts = {
  pluginId: "combat",
  player: null,
  job: null,
  filters: propertiesPlugin.filters,
  propertyTypes: new Map(),
  installedPluginIds: new Set(["combat"]),
};
const ctx = createPluginCtx(deps(), opts);

let killerId: string;
let victimId: string;
let ownerlessPlayerId: string;
let propertyId: string;
const seededProfit = 12_345n;

async function createPlayer(label: string): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username: `${label}${id.slice(-8)}` });
  await db.insert(playerStats).values({ playerId: id });
  return id;
}

beforeAll(async () => {
  await resetDb(db);
  await runPluginMigrations(db, [propertiesPlugin]);
  await subscriber.subscribe(GAME_EVENTS_CHANNEL);
});

beforeEach(async () => {
  await resetDb(db);

  killerId = await createPlayer("Killer");
  victimId = await createPlayer("Victim");
  ownerlessPlayerId = await createPlayer("Bystander");

  // Victim owns two properties, in two different locations.
  const locationAId = uuidv7();
  const locationBId = uuidv7();
  await db.insert(locations).values([
    { id: locationAId, name: "Location A" },
    { id: locationBId, name: "Location B" },
  ]);

  propertyId = uuidv7();
  await db.insert(propertiesTable).values([
    {
      id: propertyId,
      locationId: locationAId,
      pluginId: "bullets",
      ownerPlayerId: victimId,
      cost: 500_000n,
      profit: seededProfit,
    },
    {
      id: uuidv7(),
      locationId: locationBId,
      pluginId: "bullets",
      ownerPlayerId: victimId,
      cost: 250_000n,
      profit: 0n,
    },
  ]);
});

afterAll(async () => {
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("seizure on death", () => {
  it("disowns every property the victim owned, game-wide", async () => {
    await ctx.filters.apply(killResolved, { killerId, victimId });

    const rows = await db.select().from(propertiesTable);
    for (const row of rows) {
      expect(row.ownerPlayerId).toBeNull();
      expect(row.cost).toBe(0n);
    }
  });

  it("does not transfer anything to the killer", async () => {
    await ctx.filters.apply(killResolved, { killerId, victimId });

    const rows = await db.select().from(propertiesTable);
    expect(rows.some((r) => r.ownerPlayerId === killerId)).toBe(false);
  });

  it("leaves profit alone — it is the row's lifetime P&L across owners", async () => {
    await ctx.filters.apply(killResolved, { killerId, victimId });

    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(seededProfit);
  });

  /**
   * Ruling from task-8-brief.md's amendment: no `seized` plugin event is
   * published (a subscriber's ctx belongs to the APPLYING plugin — combat —
   * not to properties, so `tx.events.publish` here would be mislabeled on
   * the wire as a combat event for a name combat never declared). The
   * subscriber instead calls `tx.notify(...)`, which always publishes the
   * core `notification.created` event regardless of which plugin's ctx
   * invoked it. Asserted two ways: the event on the wire (proves the
   * player-facing channel actually fires) and the stored row (proves the
   * notification survives independently of anyone listening at the moment
   * it was sent).
   */
  it("notifies the victim, once, with a count of what was seized", async () => {
    const event = awaitOwnEvent(subscriber, victimId);
    await ctx.filters.apply(killResolved, { killerId, victimId });
    const seen = await event;

    expect(seen.type).toBe("notification.created");
    if (seen.type === "notification.created") {
      expect(seen.body).toContain("2");
    }

    const notes = await db.select().from(notifications).where(eq(notifications.playerId, victimId));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("seized");
  });

  it("is a no-op when the victim owned nothing", async () => {
    await expect(
      ctx.filters.apply(killResolved, { killerId, victimId: ownerlessPlayerId }),
    ).resolves.toBeDefined();

    // No notification for a player who owned nothing to seize.
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.playerId, ownerlessPlayerId));
    expect(notes).toHaveLength(0);

    // The victim's own properties are untouched by a kill of someone else.
    const rows = await db.select().from(propertiesTable);
    expect(rows.every((r) => r.ownerPlayerId === victimId)).toBe(true);
  });
});
