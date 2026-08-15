import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin } from "./helpers/plugin-tables.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * POST /api/properties/:id/buy, /sell, /claim and GET /api/properties.
 * Money routes follow the same lock skeleton as theft (rule 6: location
 * first, then player) and use the same `bootTestServer()` shape.
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
  fields: { cost?: bigint; rate?: bigint; ownerPlayerId?: string | null; lastClaimedAt?: Date | null; profit?: bigint },
): Promise<string> {
  const id = uuidv7();
  await db.insert(propertiesPlugin).values({
    id,
    locationId: locId,
    pluginId: "properties",
    cost: fields.cost ?? 10_000n,
    rate: fields.rate ?? 500n,
    ownerPlayerId: fields.ownerPlayerId ?? null,
    lastClaimedAt: fields.lastClaimedAt ?? null,
    profit: fields.profit ?? 0n,
  });
  return id;
}

const list = (bearer = token) =>
  app.inject({ method: "GET", url: "/api/properties", headers: { authorization: `Bearer ${bearer}` } });

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
  // GET /api/properties
  // -------------------------------------------------------------------------
  describe("GET /api/properties", () => {
    it("shapes a TableRowsResponse with all values as strings", async () => {
      const propId = await seedProperty(locationId, { cost: 50_000n, rate: 500n });

      const res = await list();
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body)).toEqual(["rows"]);
      expect(body.rows.length).toBeGreaterThanOrEqual(1);

      const row = body.rows.find((r: { id: string }) => r.id === propId);
      expect(row).toBeDefined();
      expect(row.pluginId).toBe("properties");
      expect(row.rate).toBe("500");
      expect(row.cost).toBe("50000");
      expect(row.ownerName).toBe("—");
      expect(row.accrued).toBe("0");

      // Every value must be a string.
      for (const value of Object.values(row)) {
        expect(typeof value).toBe("string");
      }
    });

    it("shows the owner name and accrued for caller-owned rows", async () => {
      const propId = await seedProperty(locationId, {
        cost: 10_000n,
        rate: 500n,
        ownerPlayerId: playerId,
        lastClaimedAt: new Date(Date.now() - 3 * 3600_000), // 3h ago
      });

      const res = await list();
      const body = res.json<{ rows: Array<{ id: string; ownerName: string; accrued: string }> }>();
      const row = body.rows.find((r) => r.id === propId);
      expect(row).toBeDefined();
      expect(row.ownerName).not.toBe("—");
      // 3 whole hours * 500 = 1500
      expect(row.accrued).toBe("1500");
    });
  });

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
      expect(row?.lastClaimedAt).not.toBeNull();

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

  // -------------------------------------------------------------------------
  // POST /api/properties/:id/sell
  // -------------------------------------------------------------------------
  describe("POST /api/properties/:id/sell", () => {
    it("sells an owned property, pays cost + accrued, resets row", async () => {
      // 3 hours ago at rate 500 → accrued = 1500.
      const propId = await seedProperty(locationId, {
        cost: 10_000n,
        rate: 500n,
        ownerPlayerId: playerId,
        lastClaimedAt: new Date(Date.now() - 3 * 3600_000),
        profit: 2000n,
      });
      const before = await cashOf(playerId);

      const res = await sell(propId);
      expect(res.statusCode).toBe(200);
      // payout = cost (10_000) + accrued (1500) = 11_500
      expect(res.json()).toMatchObject({ payout: "11500" });
      expect(await cashOf(playerId)).toBe(before + 11_500n);

      // Row back on the market.
      const [row] = await db
        .select()
        .from(propertiesPlugin)
        .where(eq(propertiesPlugin.id, propId));
      expect(row?.ownerPlayerId).toBeNull();
      expect(row?.lastClaimedAt).toBeNull();
      // profit incremented by accrued portion only.
      expect(row?.profit).toBe(2000n + 1500n);

      // Ledger.
      const ledgerRows = await db
        .select({ amount: transactions.amount, reason: transactions.reason })
        .from(transactions)
        .where(eq(transactions.playerId, playerId));
      const sellRows = ledgerRows.filter((r) => r.reason === "properties.sell");
      expect(sellRows).toHaveLength(1);
      expect(sellRows[0]?.amount).toBe(11_500n);
    });

    it("404s when the caller does not own the property", async () => {
      const { playerId: otherId } = await register();
      const propId = await seedProperty(locationId, { ownerPlayerId: otherId, lastClaimedAt: new Date() });

      const res = await sell(propId);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "not_owned" });

      // Row still owned by the other player.
      const [row] = await db
        .select()
        .from(propertiesPlugin)
        .where(eq(propertiesPlugin.id, propId));
      expect(row?.ownerPlayerId).toBe(otherId);
    });

    it("404s an unknown property id", async () => {
      const res = await sell(uuidv7());
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "property_not_found" });
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/properties/:id/claim
  // -------------------------------------------------------------------------
  describe("POST /api/properties/:id/claim", () => {
    it("banks accrued income and resets last_claimed_at", async () => {
      // 3 hours ago at rate 500 → accrued = 1500.
      const propId = await seedProperty(locationId, {
        cost: 10_000n,
        rate: 500n,
        ownerPlayerId: playerId,
        lastClaimedAt: new Date(Date.now() - 3 * 3600_000),
        profit: 3000n,
      });
      const before = await cashOf(playerId);

      const res = await claim(propId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ claimed: "1500" });
      expect(await cashOf(playerId)).toBe(before + 1500n);

      // last_claimed_at updated, profit incremented.
      const [row] = await db
        .select()
        .from(propertiesPlugin)
        .where(eq(propertiesPlugin.id, propId));
      expect(row?.lastClaimedAt).not.toBeNull();
      expect(row?.profit).toBe(3000n + 1500n);

      // Ledger.
      const ledgerRows = await db
        .select({ amount: transactions.amount, reason: transactions.reason })
        .from(transactions)
        .where(eq(transactions.playerId, playerId));
      const incomeRows = ledgerRows.filter((r) => r.reason === "properties.income");
      expect(incomeRows).toHaveLength(1);
      expect(incomeRows[0]?.amount).toBe(1500n);
    });

    it("answers claimed: 0 on a double claim without touching last_claimed_at", async () => {
      const propId = await seedProperty(locationId, {
        rate: 500n,
        ownerPlayerId: playerId,
        lastClaimedAt: new Date(Date.now() - 3 * 3600_000),
      });

      // First claim banks the 1500.
      const first = await claim(propId);
      expect(first.statusCode).toBe(200);
      expect(first.json().claimed).toBe("1500");

      // Record last_claimed_at after the first claim.
      const [afterFirst] = await db
        .select({ lastClaimedAt: propertiesPlugin.lastClaimedAt })
        .from(propertiesPlugin)
        .where(eq(propertiesPlugin.id, propId));

      // Second claim immediately — should answer 0.
      const second = await claim(propId);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ claimed: "0" });

      // last_claimed_at must NOT have moved from the first claim's value.
      const [afterSecond] = await db
        .select({ lastClaimedAt: propertiesPlugin.lastClaimedAt })
        .from(propertiesPlugin)
        .where(eq(propertiesPlugin.id, propId));
      expect(afterSecond?.lastClaimedAt?.getTime()).toBe(afterFirst?.lastClaimedAt?.getTime());
    });

    it("404s when the caller does not own the property", async () => {
      const { playerId: otherId } = await register();
      const propId = await seedProperty(locationId, {
        rate: 500n,
        ownerPlayerId: otherId,
        lastClaimedAt: new Date(Date.now() - 3 * 3600_000),
      });

      const res = await claim(propId);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "not_owned" });
    });

    it("404s an unknown property id", async () => {
      const res = await claim(uuidv7());
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "property_not_found" });
    });
  });

  // -------------------------------------------------------------------------
  // Ledger invariant spot-checks
  // -------------------------------------------------------------------------
  it("sum(ledger) == balance for buy and sell", async () => {
    const propId = await seedProperty(locationId, { cost: 50_000n, rate: 500n });
    const before = await cashOf(playerId);

    // Buy.
    const buyRes = await buy(propId);
    expect(buyRes.statusCode).toBe(200);

    // Travel forward in time by updating last_claimed_at.
    await db
      .update(propertiesPlugin)
      .set({ lastClaimedAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(propertiesPlugin.id, propId));

    // Sell.
    const sellRes = await sell(propId);
    expect(sellRes.statusCode).toBe(200);

    const after = await cashOf(playerId);
    const delta = after - before;

    const ledgerRows = await db
      .select({ amount: transactions.amount })
      .from(transactions)
      .where(eq(transactions.playerId, playerId));
    const sumAmount = ledgerRows.reduce((s, r) => s + r.amount, 0n);

    // The property-related ledger rows should account for the delta.
    const propRows = ledgerRows.filter((_, i) => {
      // All rows for this player are property-related in this test.
      return true;
    });
    expect(propRows.reduce((s, r) => s + r.amount, 0n)).toBe(delta);
  });
});
