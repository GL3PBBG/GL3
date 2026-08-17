import bulletsPlugin from "@gl3/plugin-bullets";
import propertiesPlugin from "@gl3/plugin-properties";
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats } from "../src/db/schema/index.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { callPluginRoute } from "./helpers/plugin-route.js";
import { propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";

/**
 * `GET /api/bullets/shop` and the two caps that hang off it. Driven through
 * `callPluginRoute` rather than `bootTestServer` because every case here needs
 * its own settings record and settings are a boot-time snapshot — booting per
 * permutation is what makes `theft-chase.test.ts` the slowest file in the
 * suite.
 */
const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const leaderboardPrefix = `bullets-shop-test-${uuidv7()}`;

let playerId: string;
let locationId: string;

const shop = (forPlayerId: string, s: Record<string, string> = {}) =>
  callPluginRoute(bulletsPlugin, "GET", "/api/bullets/shop", {
    db, redis, leaderboardPrefix, playerId: forPlayerId, settings: s,
  });

const buy = (forPlayerId: string, quantity: number, s: Record<string, string> = {}) =>
  callPluginRoute(bulletsPlugin, "POST", "/api/bullets/buy", {
    db, redis, leaderboardPrefix, playerId: forPlayerId, body: { quantity }, settings: s,
  });

/** Parks the restock cursor on the current hour so a test never restocks by accident. */
async function freezeCursor(): Promise<void> {
  await db.execute(sql`
    insert into settings (key, value)
    values ('bullets.last_restock', extract(epoch from date_trunc('hour', now()))::bigint::text)
    on conflict (key) do update set value = excluded.value`);
}

async function ownFactory(lever: bigint): Promise<string> {
  const ownerId = uuidv7();
  await db.insert(players).values({ id: ownerId, username: `owner${Date.now()}${Math.trunc(performance.now())}` });
  await db.insert(playerStats).values({ playerId: ownerId, cash: 1_000_000n, locationId });
  await db.insert(propertiesTable).values({
    id: uuidv7(), locationId, pluginId: "bullets", ownerPlayerId: ownerId, cost: lever, profit: 0n,
  });
  return ownerId;
}

beforeAll(async () => {
  await runPluginMigrations(db, [propertiesPlugin]);
});

beforeEach(async () => {
  await resetDb(db);
  locationId = uuidv7();
  await db.insert(locations).values({ id: locationId, name: "Testville", bulletStock: 10, bulletCost: 5n });
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}${Math.trunc(performance.now())}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n, bullets: 3n, locationId });
});

afterAll(async () => {
  await redis.del(`${leaderboardPrefix}:cash`);
  await conn.end();
  redis.disconnect();
});

describe("GET /api/bullets/shop", () => {
  it("reports the standing location's stock, price and the player's own bullets", async () => {
    await freezeCursor();

    const result = await shop(playerId);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      locationId, locationName: "Testville", bulletStock: 10,
      unitCost: "5", maxBuy: null, bullets: "3",
    });
  });

  it("restocks on the way past when the cursor is stale", async () => {
    // The whole reason this route exists: it is the only read a player can
    // reach at zero stock, so it is where the refill has to happen.
    await db.update(locations).set({ bulletStock: 0 }).where(eq(locations.id, locationId));

    const result = await shop(playerId, { "bullets.stock_min_per_hour": "10", "bullets.stock_max_per_hour": "10" });

    expect(result.status).toBe(200);
    expect((result.body as { bulletStock: number }).bulletStock).toBe(120); // 12h clamp x 10
  });

  it("answers 409 no_location for a player who is nowhere", async () => {
    await db.update(playerStats).set({ locationId: null }).where(eq(playerStats.playerId, playerId));

    await expect(shop(playerId)).rejects.toMatchObject({ code: "no_location", status: 409 });
  });

  it("reports the owner's lever, not the location price, when a factory is owned", async () => {
    await freezeCursor();
    await ownFactory(9n);

    const result = await shop(playerId);

    // The page used to render locations.bullet_cost while the buy route
    // charged the lever, so an owned town displayed a price it would not charge.
    expect((result.body as { unitCost: string }).unitCost).toBe("9");
  });

  it("reports the max_cost-clamped price when the owner's lever exceeds the cap", async () => {
    await freezeCursor();
    await ownFactory(9n);

    const result = await shop(playerId, { "bullets.max_cost": "6" });

    expect((result.body as { unitCost: string }).unitCost).toBe("6");
  });

  it("reports max_buy when one is configured", async () => {
    await freezeCursor();

    const result = await shop(playerId, { "bullets.max_buy": "4" });

    expect((result.body as { maxBuy: number | null }).maxBuy).toBe(4);
  });
});

describe("the bullets caps", () => {
  it("refuses a purchase above max_buy", async () => {
    await expect(buy(playerId, 5, { "bullets.max_buy": "4" }))
      .rejects.toMatchObject({ code: "quantity_above_max", status: 400 });
  });

  it("allows a purchase exactly at max_buy", async () => {
    const result = await buy(playerId, 4, { "bullets.max_buy": "4" });
    expect(result.status).toBe(200);
  });

  it("charges the capped price when the owner's lever is above max_cost", async () => {
    await ownFactory(9n);

    const result = await buy(playerId, 2, { "bullets.max_cost": "6" });

    // 1000 - 2*6, not 1000 - 2*9.
    expect((result.body as { cash: string }).cash).toBe("988");
  });

  it("caps the location's own price too, not only an owner's lever", async () => {
    await db.update(locations).set({ bulletCost: 50n }).where(eq(locations.id, locationId));

    const result = await buy(playerId, 2, { "bullets.max_cost": "6" });

    expect((result.body as { cash: string }).cash).toBe("988");
  });

  it("leaves the price alone when no cap is set", async () => {
    const result = await buy(playerId, 2);
    expect((result.body as { cash: string }).cash).toBe("990");
  });
});
