import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import propertiesPlugin, { ownerAt, payOwner, propertiesTable } from "@gl3/plugin-properties";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats } from "../src/db/schema/index.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

// This file drives the plugin's API functions directly (no bootTestServer, no
// HTTP), so nothing else applies the properties migrations first — the
// template database every test file clones is built from CORE migrations
// only. Pattern: apps/server/test/properties-lock-order.test.ts.
const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

const leaderboardPrefix = `payowner-test-${uuidv7()}`;
const deps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix });
const opts = { pluginId: "bullets", player: null, job: null, filters: [], propertyTypes: new Map() };
const ctx = createPluginCtx(deps(), opts);

let locationId: string;
let unownedLocationId: string;
let ownerId: string;
let propertyId: string;
let unownedPropertyId: string;
const startingCash = 1_000_000n;

async function cashOf(playerId: string): Promise<bigint> {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
  return row?.cash ?? 0n;
}

beforeAll(async () => {
  await resetDb(db);
  await runPluginMigrations(db, [propertiesPlugin]);

  locationId = uuidv7();
  unownedLocationId = uuidv7();
  await db.insert(locations).values([
    { id: locationId, name: "Owned Town" },
    { id: unownedLocationId, name: "Unowned Town" },
  ]);

  ownerId = uuidv7();
  await db.insert(players).values({ id: ownerId, username: `payowner${ownerId}` });
  await db.insert(playerStats).values({ playerId: ownerId, cash: startingCash });

  propertyId = uuidv7();
  unownedPropertyId = uuidv7();
  await db.insert(propertiesTable).values([
    { id: propertyId, locationId, pluginId: "bullets", ownerPlayerId: ownerId, cost: 0n, profit: 0n },
    { id: unownedPropertyId, locationId: unownedLocationId, pluginId: "bullets", ownerPlayerId: null, cost: 0n, profit: 0n },
  ]);
});

afterAll(async () => {
  await conn.end();
  redis.disconnect();
});

describe("payOwner", () => {
  // Each case is self-contained: reset the owner's cash and the property's
  // lifetime profit to a known baseline before every test, so a test's
  // assertion is about THAT test's move, not the sum of the ones before it.
  beforeEach(async () => {
    await db.update(playerStats).set({ cash: startingCash }).where(eq(playerStats.playerId, ownerId));
    await db.update(propertiesTable).set({ profit: 0n }).where(eq(propertiesTable.id, propertyId));
  });

  it("credits the owner and moves profit by the same amount", async () => {
    const moved = await ctx.transaction(async (tx) => {
      await tx.locks.location(locationId);
      await tx.locks.player([ownerId]);
      return payOwner(tx, propertyId, 5_000n, "test.credit");
    });
    expect(moved).toBe(5_000n);
    expect(await cashOf(ownerId)).toBe(startingCash + 5_000n);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(5_000n);
  });

  it("debits the owner and drives profit negative", async () => {
    const moved = await ctx.transaction(async (tx) => {
      await tx.locks.location(locationId);
      await tx.locks.player([ownerId]);
      return payOwner(tx, propertyId, -2_000n, "test.debit");
    });
    expect(moved).toBe(-2_000n);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(-2_000n);
  });

  it("clamps a debit larger than the owner's cash and moves profit by what was taken", async () => {
    // owner cash is exactly 1_000n here
    await db.update(playerStats).set({ cash: 1_000n }).where(eq(playerStats.playerId, ownerId));

    const moved = await ctx.transaction(async (tx) => {
      await tx.locks.location(locationId);
      await tx.locks.player([ownerId]);
      return payOwner(tx, propertyId, -9_999n, "test.overdraft");
    });
    expect(moved).toBe(-1_000n);
    expect(await cashOf(ownerId)).toBe(0n);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(-1_000n); // never claims a loss the ledger did not take
  });

  it("is a no-op on an unowned property", async () => {
    const moved = await ctx.transaction(async (tx) => {
      await tx.locks.location(unownedLocationId);
      return payOwner(tx, unownedPropertyId, 5_000n, "test.credit");
    });
    expect(moved).toBe(0n);
  });
});

describe("ownerAt", () => {
  it("returns null for an unowned property", async () => {
    const found = await ctx.transaction((tx) => ownerAt(tx, "bullets", unownedLocationId));
    expect(found).toBeNull();
  });

  it("returns null lever when cost is zero", async () => {
    const found = await ctx.transaction((tx) => ownerAt(tx, "bullets", locationId));
    expect(found).toMatchObject({ propertyId, ownerId, lever: null });
  });

  it("returns the lever when the owner has set one", async () => {
    await db.update(propertiesTable).set({ cost: 42_000n }).where(eq(propertiesTable.id, propertyId));
    const found = await ctx.transaction((tx) => ownerAt(tx, "bullets", locationId));
    expect(found?.lever).toBe(42_000n);
  });
});
