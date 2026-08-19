import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * bullets becomes the properties SDK's first consumer (Task 9): the
 * factory's owner sets the price per bullet and takes half of every sale
 * (V2's `bullets.inc.php:86` and `:225`). An unowned factory — or one whose
 * owner has set no lever — must still charge exactly the location's own
 * `bullet_cost`, unchanged from before this task (`test/bullets.test.ts` is
 * that port-fidelity proof and stays green alongside this file).
 *
 * Driven through the real HTTP route and the real `ownerAt`/`payOwner` from
 * `@gl3/plugin-properties` — nothing here is mocked.
 */

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

const startingCash = 1_000_000_000n;
/** location.bulletCost — what an unowned (or leverless) factory falls back to. */
const locationPrice = 5n;

async function cashOf(playerId: string): Promise<bigint> {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
  return row?.cash ?? 0n;
}

let regCounter = 0;
async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  // Registration is rate-limited per IP and the app is booted once, so
  // every registration in this file must use a distinct address.
  return registerVerifiedPlayer({ app, redis }, {
    username: `Franchise${regCounter}${Date.now()}`,
    remoteAddress: `10.77.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
}

/**
 * A fresh location and a fresh buyer standing there. When `ownership` is
 * given, a fresh owner (also standing there) holds the location's bullets
 * franchise with that lever. Each test gets its own location and players so
 * scenarios never interfere with each other.
 */
async function scenario(ownership: { lever: bigint } | null): Promise<{
  buyerHeaders: { authorization: string };
  ownerHeaders: { authorization: string } | null;
  buyerId: string;
  ownerId: string | null;
  propertyId: string | null;
}> {
  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `loc-${locationId.slice(-8)}`,
    bulletStock: 1_000_000,
    bulletCost: locationPrice,
  });

  const buyer = await register();
  await db.update(playerStats)
    .set({ cash: startingCash, locationId })
    .where(eq(playerStats.playerId, buyer.playerId));

  let ownerHeaders: { authorization: string } | null = null;
  let ownerId: string | null = null;
  let propertyId: string | null = null;
  if (ownership !== null) {
    const owner = await register();
    ownerId = owner.playerId;
    ownerHeaders = { authorization: `Bearer ${owner.token}` };
    await db.update(playerStats)
      .set({ cash: startingCash, locationId })
      .where(eq(playerStats.playerId, owner.playerId));

    propertyId = uuidv7();
    await db.insert(propertiesPlugin).values({
      id: propertyId,
      locationId,
      pluginId: "bullets",
      ownerPlayerId: owner.playerId,
      cost: ownership.lever,
      profit: 0n,
    });
  }

  return {
    buyerHeaders: { authorization: `Bearer ${buyer.token}` },
    ownerHeaders,
    buyerId: buyer.playerId,
    ownerId,
    propertyId,
  };
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("bullets as a properties franchise", () => {
  it("charges the location price when the factory is unowned", async () => {
    const { buyerHeaders, buyerId } = await scenario(null);
    const before = await cashOf(buyerId);

    const res = await app.inject({
      method: "POST", url: "/api/bullets/buy", headers: buyerHeaders, payload: { quantity: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(await cashOf(buyerId)).toBe(before - locationPrice * 10n);
  });

  it("charges the owner's lever when one is set", async () => {
    const { buyerHeaders, buyerId } = await scenario({ lever: 999n });
    const before = await cashOf(buyerId);

    const res = await app.inject({
      method: "POST", url: "/api/bullets/buy", headers: buyerHeaders, payload: { quantity: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(await cashOf(buyerId)).toBe(before - 999n * 10n);
  });

  it("falls back to the location price when the owner set no lever", async () => {
    const { buyerHeaders, buyerId } = await scenario({ lever: 0n });
    const before = await cashOf(buyerId);

    const res = await app.inject({
      method: "POST", url: "/api/bullets/buy", headers: buyerHeaders, payload: { quantity: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(await cashOf(buyerId)).toBe(before - locationPrice * 10n);
  });

  it("pays the owner half the sale and moves the property's profit", async () => {
    const { buyerHeaders, ownerId, propertyId } = await scenario({ lever: 999n });
    const ownerBefore = await cashOf(ownerId!);

    const res = await app.inject({
      method: "POST", url: "/api/bullets/buy", headers: buyerHeaders, payload: { quantity: 10 },
    });
    expect(res.statusCode).toBe(200);

    const total = 999n * 10n;
    expect(await cashOf(ownerId!)).toBe(ownerBefore + total / 2n);
    const [row] = await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.id, propertyId!));
    expect(row!.profit).toBe(total / 2n);
  });

  it("lets the owner buy from their own factory", async () => {
    const { ownerHeaders, ownerId } = await scenario({ lever: 999n });
    const ownerCashBefore = await cashOf(ownerId!);

    const res = await app.inject({
      method: "POST", url: "/api/bullets/buy", headers: ownerHeaders!, payload: { quantity: 10 },
    });
    expect(res.statusCode).toBe(200);

    // Paid 999*10 and received half of it back.
    const total = 999n * 10n;
    expect(await cashOf(ownerId!)).toBe(ownerCashBefore - total + total / 2n);
  });
});
