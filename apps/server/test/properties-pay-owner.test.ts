import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import propertiesPlugin, { ownerAt, payOwner, propertiesTable } from "@gl3/plugin-properties";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats, settings } from "../src/db/schema/index.js";
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
const opts = {
  pluginId: "bullets", player: null, job: null, filters: [], propertyTypes: new Map(),
  installedPluginIds: new Set(["bullets"]),
};
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

  // The core-contract cases below predate the franchise skim and stay about
  // clamping/ownership/debits, so they run with the skim pinned OFF; the skim
  // describe manipulates the row per case and restores it.
  await db.insert(settings).values({ key: "properties.skim_percent", value: "0" });
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

  describe("franchise skim", () => {
    // The knob is read LIVE from the table, so each case rewrites the row and
    // restores the "0" the beforeAll pinned for the contract cases above.
    const setSkim = async (value: string | null) => {
      if (value === null) {
        await db.delete(settings).where(eq(settings.key, "properties.skim_percent"));
      } else {
        await db.insert(settings).values({ key: "properties.skim_percent", value })
          .onConflictDoUpdate({ target: settings.key, set: { value } });
      }
    };

    afterEach(async () => { await setSkim("0"); });

    it("skims the default 10% of a credit when no row is stored", async () => {
      await setSkim(null);
      const moved = await ctx.transaction(async (tx) => {
        await tx.locks.location(locationId);
        await tx.locks.player([ownerId]);
        return payOwner(tx, propertyId, 5_000n, "test.credit");
      });
      // 10% of 5,000 destroyed by never being credited; profit moves by the
      // credited figure only.
      expect(moved).toBe(4_500n);
      expect(await cashOf(ownerId)).toBe(startingCash + 4_500n);
      const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
      expect(row!.profit).toBe(4_500n);
    });

    it("honours an explicit percent, live — no restart", async () => {
      await setSkim("25");
      const moved = await ctx.transaction(async (tx) => {
        await tx.locks.location(locationId);
        await tx.locks.player([ownerId]);
        return payOwner(tx, propertyId, 8_000n, "test.credit");
      });
      expect(moved).toBe(6_000n);
      expect(await cashOf(ownerId)).toBe(startingCash + 6_000n);
    });

    it("rounds the destroyed share up — the void gets the rounding", async () => {
      await setSkim("10");
      const moved = await ctx.transaction(async (tx) => {
        await tx.locks.location(locationId);
        await tx.locks.player([ownerId]);
        return payOwner(tx, propertyId, 1_001n, "test.credit");
      });
      // ceil(1,001 × 10%) = 101 destroyed, 900 credited.
      expect(moved).toBe(900n);
    });

    it("never skims a debit — a house pays out in full", async () => {
      // 50% skim would gut a payout if the debit path were skimmed too.
      await setSkim("50");
      const moved = await ctx.transaction(async (tx) => {
        await tx.locks.location(locationId);
        await tx.locks.player([ownerId]);
        return payOwner(tx, propertyId, -2_000n, "test.debit");
      });
      expect(moved).toBe(-2_000n);
      expect(await cashOf(ownerId)).toBe(startingCash - 2_000n);
    });
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
