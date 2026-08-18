import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locations, playerStats, settings } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The bullet price on the travel board must be the price the shop actually
 * charges. `GET /api/locations` used to answer with the raw
 * `locations.bullet_cost`, but the shop charges
 * `effectiveCost(lever, bulletCost, maxCost)` — an owned factory's lever,
 * clamped by the admin's `bullets.max_cost` cap — so the board lied whenever a
 * factory was owned or the cap bit. Travel now runs its listing through the
 * `travel.locationsListed` filter point and bullets rewrites the quote.
 *
 * Driven through the real HTTP route, not `callPluginRoute`: the helper passes
 * only the called plugin's OWN filters into the ctx, so bullets' cross-plugin
 * subscription would silently never run and the test would prove nothing.
 */
const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

const locationPrice = 5n;

let regCounter = 0;
async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  // Registration is rate-limited per IP and the app is booted once, so
  // every registration in this file must use a distinct address.
  return registerVerifiedPlayer({ app, redis }, {
    username: `Quote${regCounter}${Date.now()}`,
    remoteAddress: `10.81.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
}

/**
 * A fresh location, a viewer standing anywhere, and — when `lever` is given —
 * an owner holding the location's bullets franchise at that lever (0n models
 * "owned but no lever set", matching `ownerAt`'s `cost > 0n` reading).
 */
async function scenario(lever: bigint | null): Promise<{
  locationId: string;
  viewerHeaders: { authorization: string };
}> {
  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `quote-${locationId.slice(-8)}`,
    bulletStock: 1_000_000,
    bulletCost: locationPrice,
  });

  const viewer = await register();

  if (lever !== null) {
    const owner = await register();
    await db.update(playerStats)
      .set({ locationId })
      .where(eq(playerStats.playerId, owner.playerId));
    await db.insert(propertiesPlugin).values({
      id: uuidv7(),
      locationId,
      pluginId: "bullets",
      ownerPlayerId: owner.playerId,
      cost: lever,
      profit: 0n,
    });
  }

  return { locationId, viewerHeaders: { authorization: `Bearer ${viewer.token}` } };
}

async function quotedPrice(locationId: string, headers: { authorization: string }): Promise<string> {
  const res = await app.inject({ method: "GET", url: "/api/locations", headers });
  expect(res.statusCode).toBe(200);
  const { locations: rows } = res.json<{ locations: Array<{ id: string; bulletCost: string }> }>();
  const row = rows.find((l) => l.id === locationId);
  expect(row).toBeDefined();
  return (row as { bulletCost: string }).bulletCost;
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("the travel board quotes the shop's effective bullet price", () => {
  it("shows the location's own price for an unowned factory", async () => {
    const { locationId, viewerHeaders } = await scenario(null);
    expect(await quotedPrice(locationId, viewerHeaders)).toBe(locationPrice.toString());
  });

  it("shows the owner's lever when the factory is owned and priced", async () => {
    const { locationId, viewerHeaders } = await scenario(999n);
    expect(await quotedPrice(locationId, viewerHeaders)).toBe("999");
  });

  it("falls back to the location price when the owner set no lever", async () => {
    const { locationId, viewerHeaders } = await scenario(0n);
    expect(await quotedPrice(locationId, viewerHeaders)).toBe(locationPrice.toString());
  });

  it("clamps the quote to the admin's max_cost cap, exactly as the shop does", async () => {
    await db.insert(settings).values({ key: "bullets.max_cost", value: "700" });
    try {
      const { locationId, viewerHeaders } = await scenario(999n);
      expect(await quotedPrice(locationId, viewerHeaders)).toBe("700");
    } finally {
      await db.delete(settings).where(eq(settings.key, "bullets.max_cost"));
    }
  });
});
