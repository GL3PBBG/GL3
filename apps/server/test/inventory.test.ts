import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { items, playerItems } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

// Both helpers close over the single module-level `db`. testDb() calls
// createDb(), which opens a NEW connection pool on every call — only the one
// created above is ended in afterAll, so calling it again per test leaks a
// pool for the lifetime of the run.
async function seedItem(itemType: string, effects: Record<string, unknown>): Promise<string> {
  const id = uuidv7();
  await db.insert(items).values({ id, name: `${itemType}-${id.slice(-8)}`, itemType, effects });
  return id;
}

async function grant(playerId: string, itemId: string, qty: number): Promise<void> {
  await db.insert(playerItems).values({ playerId, itemId, qty });
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "Sal", password: "hunter2hunter2" },
  });
  ({ token, playerId } = reg.json());
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("GET /api/inventory", () => {
  it("returns an empty inventory for a new player", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/inventory",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], equipped: { weaponItemId: null, armorItemId: null } });
  });

  it("lists owned items with their effects, and hides zero-qty rows", async () => {
    const pistol = await seedItem("weapon", { accuracy: 60, damageMin: 5, damageMax: 15 });
    const gone = await seedItem("consumable", { heal: 20 });
    await grant(playerId, pistol, 1);
    await grant(playerId, gone, 0);

    const res = await app.inject({
      method: "GET", url: "/api/inventory",
      headers: { authorization: `Bearer ${token}` },
    });

    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ itemId: pistol, itemType: "weapon", qty: 1 });
    expect(body.items[0].effects).toMatchObject({ accuracy: 60, damageMin: 5, damageMax: 15 });
  });

  it("fills the weapon defaults a migrated V2 item does not carry", async () => {
    // V2's itemEffects had a bare `damage` and none of the rest, so the
    // client must not have to know which fields default to what.
    const pistol = await seedItem("weapon", { accuracy: 60, damageMin: 5, damageMax: 15 });
    await grant(playerId, pistol, 1);

    const res = await app.inject({
      method: "GET", url: "/api/inventory",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json().items[0].effects).toEqual({
      accuracy: 60, damageMin: 5, damageMax: 15,
      bulletsPerShot: 1, critChance: 0, critMultiplier: 1, armorPierce: 0, minRankExp: 0,
    });
  });

  it("nulls the effects of a known item type whose jsonb does not parse", async () => {
    const junk = await seedItem("armor", { armor: "not a number" });
    await grant(playerId, junk, 1);

    const res = await app.inject({
      method: "GET", url: "/api/inventory",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json().items[0]).toMatchObject({ itemId: junk, effects: null });
  });

  it("passes through the effects of an unrecognised item type untouched", async () => {
    // `item_type` is unconstrained text and V2 shipped types beyond the
    // three this plugin models, so an unknown type must not be nulled.
    const car = await seedItem("car", { topSpeed: 180, plate: "GL3" });
    await grant(playerId, car, 1);

    const res = await app.inject({
      method: "GET", url: "/api/inventory",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json().items[0].effects).toEqual({ topSpeed: 180, plate: "GL3" });
  });

  it("does not list another player's items", async () => {
    // The where clause is two conjuncts and only `qty > 0` was covered; this
    // one fails if `playerId` is ever dropped from it.
    const other = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Tony", password: "hunter2hunter2" },
    });
    const pistol = await seedItem("weapon", { accuracy: 60, damageMin: 5, damageMax: 15 });
    await grant(other.json().playerId, pistol, 1);

    const res = await app.inject({
      method: "GET", url: "/api/inventory",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json().items).toEqual([]);
  });
});
