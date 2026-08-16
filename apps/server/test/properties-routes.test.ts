import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin } from "./helpers/plugin-tables.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * POST /api/properties/:id/buy and GET /api/properties. sell and claim are
 * gone (Task 5): a property earns what its consumer plugin pays it, as in
 * V2, not from an accrual clock this route managed.
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;
let locationId: string;
let auth: { authorization: string };

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.50.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
    payload: { username: `PropOwner${regCounter}`, password: "hunter2hunter2" },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function seedLocation(): Promise<string> {
  const id = uuidv7();
  await db.insert(locations).values({
    id,
    name: `city-${id.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  return id;
}

async function seedProperty(
  locId: string,
  fields: { cost?: bigint; ownerPlayerId?: string | null; profit?: bigint },
): Promise<string> {
  const id = uuidv7();
  await db.insert(propertiesPlugin).values({
    id,
    locationId: locId,
    pluginId: "properties",
    cost: fields.cost ?? 10_000n,
    ownerPlayerId: fields.ownerPlayerId ?? null,
    profit: fields.profit ?? 0n,
  });
  return id;
}

const buy = (propId: unknown, bearer = token) =>
  app.inject({
    method: "POST",
    url: `/api/properties/${propId}/buy`,
    headers: { authorization: `Bearer ${bearer}` },
  });

const sell = (propId: unknown, bearer = token) =>
  app.inject({
    method: "POST",
    url: `/api/properties/${propId}/sell`,
    headers: { authorization: `Bearer ${bearer}` },
  });

const claim = (propId: unknown, bearer = token) =>
  app.inject({
    method: "POST",
    url: `/api/properties/${propId}/claim`,
    headers: { authorization: `Bearer ${bearer}` },
  });

const cashOf = async (id: string): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, id));
  return row?.cash ?? 0n;
};

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  ({ token, playerId } = await register());
  auth = { authorization: `Bearer ${token}` };
  locationId = await seedLocation();
  await db
    .update(playerStats)
    .set({ locationId, cash: 1_000_000n })
    .where(eq(playerStats.playerId, playerId));
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("properties routes", () => {
  // -------------------------------------------------------------------------
  // POST /api/properties/:id/buy
  // -------------------------------------------------------------------------
  describe("POST /api/properties/:id/buy", () => {
    it("buys an unowned property, debits cash and sets owner", async () => {
      const propId = await seedProperty(locationId, { cost: 50_000n });
      const before = await cashOf(playerId);

      const res = await buy(propId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ propertyId: propId });

      // Cash decreased by cost.
      expect(await cashOf(playerId)).toBe(before - 50_000n);

      // Row now owned.
      const [row] = await db
        .select()
        .from(propertiesPlugin)
        .where(eq(propertiesPlugin.id, propId));
      expect(row?.ownerPlayerId).toBe(playerId);

      // One ledger row for the purchase.
      const ledgerRows = await db
        .select({ amount: transactions.amount, reason: transactions.reason })
        .from(transactions)
        .where(eq(transactions.playerId, playerId));
      const buyRows = ledgerRows.filter((r) => r.reason === "properties.buy");
      expect(buyRows).toHaveLength(1);
      expect(buyRows[0]?.amount).toBe(-50_000n);
    });

    it("409s when the property is already owned by another player", async () => {
      const { playerId: otherId } = await register();
      const propId = await seedProperty(locationId, { ownerPlayerId: otherId });
      const before = await cashOf(playerId);

      const res = await buy(propId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "already_owned" });

      // No money moved.
      expect(await cashOf(playerId)).toBe(before);
      const ledgerRows = await db
        .select({ reason: transactions.reason })
        .from(transactions)
        .where(eq(transactions.playerId, playerId));
      expect(ledgerRows.filter((r) => r.reason === "properties.buy")).toHaveLength(0);
    });

    it("409s when the property is already owned by the caller", async () => {
      const propId = await seedProperty(locationId, { ownerPlayerId: playerId });
      const before = await cashOf(playerId);

      const res = await buy(propId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "already_owned" });

      expect(await cashOf(playerId)).toBe(before);
    });

    it("409s with insufficient_funds when the player cannot afford it", async () => {
      const propId = await seedProperty(locationId, { cost: 5_000_000n });
      const before = await cashOf(playerId);

      const res = await buy(propId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "insufficient_funds" });

      // Row unchanged.
      const [row] = await db
        .select()
        .from(propertiesPlugin)
        .where(eq(propertiesPlugin.id, propId));
      expect(row?.ownerPlayerId).toBeNull();

      expect(await cashOf(playerId)).toBe(before);
      const ledgerRows = await db
        .select({ reason: transactions.reason })
        .from(transactions)
        .where(eq(transactions.playerId, playerId));
      expect(ledgerRows.filter((r) => r.reason === "properties.buy")).toHaveLength(0);
    });

    it("404s an unknown property id", async () => {
      const res = await buy(uuidv7());
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "property_not_found" });
    });

    it("401s without a token", async () => {
      const propId = await seedProperty(locationId, { cost: 50_000n });
      const res = await app.inject({ method: "POST", url: `/api/properties/${propId}/buy` });
      expect(res.statusCode).toBe(401);
    });
  });

  it("has no claim or sell route", async () => {
    // Owned by the caller, so under the old code both routes would answer
    // 200 here — a fresh, unowned row would 404 on "not_owned" regardless of
    // whether the route exists at all, proving nothing.
    const propId = await seedProperty(locationId, {
      cost: 50_000n,
      ownerPlayerId: playerId,
    });

    const claimRes = await claim(propId);
    expect(claimRes.statusCode).toBe(404);

    const sellRes = await sell(propId);
    expect(sellRes.statusCode).toBe(404);
  });
});
