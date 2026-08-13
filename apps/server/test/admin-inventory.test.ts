import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations } from "../src/db/schema/content.js";
import { items } from "../src/db/schema/content.js";
import { playerStats } from "../src/db/schema/identity.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";
import { uuidv7 } from "uuidv7";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let adminToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  const founder = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "Founder", password: "hunter2hunter2" },
  });
  adminToken = founder.json().token;
});

afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${adminToken}` });

describe("inventory admin", () => {
  describe("items", () => {
    it("creates a weapon whose effects parse through the combat schema", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Lupara", itemType: "weapon", damageMin: 10, damageMax: 20, accuracy: 65 },
      });
      expect(res.statusCode).toBe(201);
      const id: string = res.json().id;
      const [row] = await db.select().from(items).where(eq(items.id, id));
      expect(row?.itemType).toBe("weapon");
      expect(row?.effects).toEqual({
        damageMin: 10, damageMax: 20, accuracy: 65,
        bulletsPerShot: 1, critChance: 0, critMultiplier: 1, armorPierce: 0, minRankExp: 0,
      });
    });

    it("creates an armor item", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Kevlar Vest", itemType: "armor", armor: 30 },
      });
      expect(res.statusCode).toBe(201);
      const id: string = res.json().id;
      const [row] = await db.select().from(items).where(eq(items.id, id));
      expect(row?.itemType).toBe("armor");
      expect(row?.effects).toEqual({ armor: 30 });
    });

    it("creates a consumable item", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Medkit", itemType: "consumable", heal: 25 },
      });
      expect(res.statusCode).toBe(201);
      const id: string = res.json().id;
      const [row] = await db.select().from(items).where(eq(items.id, id));
      expect(row?.itemType).toBe("consumable");
      expect(row?.effects).toEqual({ heal: 25 });
    });

    it("rejects a weapon with damageMax < damageMin", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Broken", itemType: "weapon", damageMin: 20, damageMax: 10 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("lists items with stringified effects", async () => {
      const create = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Lupara", itemType: "weapon", damageMin: 10, damageMax: 20, accuracy: 65 },
      });
      expect(create.statusCode).toBe(201);
      const id: string = create.json().id;

      const list = await app.inject({ method: "GET", url: "/api/admin/inventory/items", headers: auth() });
      expect(list.statusCode).toBe(200);
      const rows = list.json().rows as Array<{ id: string; name: string; itemType: string; effects: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].name).toBe("Lupara");
      expect(rows[0].itemType).toBe("weapon");
      const parsed = JSON.parse(rows[0].effects);
      expect(parsed).toMatchObject({ damageMin: 10, damageMax: 20, accuracy: 65 });
    });

    it("403s a non-admin", async () => {
      const p = await app.inject({
        method: "POST", url: "/api/auth/register",
        payload: { username: "Pleb", password: "hunter2hunter2" },
      });
      const res = await app.inject({
        method: "GET", url: "/api/admin/inventory/items",
        headers: { authorization: `Bearer ${p.json().token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("locations feed", () => {
    // Feeds the shop form's location select. `GET /api/admin/inventory/shop`
    // cannot serve that role: it lists existing stock rows, which is empty
    // exactly when the admin stocks a location for the first time.
    it("lists all locations as id/name rows", async () => {
      const locationId = uuidv7();
      await db.insert(locations).values({
        id: locationId, name: "Palermo",
        travelCost: 0n, travelCooldownSeconds: 0,
        bulletStock: 0, bulletCost: 0n,
      });
      const res = await app.inject({
        method: "GET", url: "/api/admin/inventory/locations", headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows).toEqual([{ id: locationId, name: "Palermo" }]);
    });

    it("403s a non-admin", async () => {
      const p = await app.inject({
        method: "POST", url: "/api/auth/register",
        payload: { username: "Pleb", password: "hunter2hunter2" },
      });
      const res = await app.inject({
        method: "GET", url: "/api/admin/inventory/locations",
        headers: { authorization: `Bearer ${p.json().token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("shop stock", () => {
    it("stocks the shop and the public listing sees it", async () => {
      // Seed a location via direct insert
      const locationId = uuidv7();
      await db.insert(locations).values({
        id: locationId, name: "Palermo",
        travelCost: 0n, travelCooldownSeconds: 0,
        bulletStock: 0, bulletCost: 0n,
      });

      // Create an item via the admin route
      const itemRes = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Lupara", itemType: "weapon", damageMin: 10, damageMax: 20, accuracy: 65 },
      });
      expect(itemRes.statusCode).toBe(201);
      const itemId: string = itemRes.json().id;

      // Register a player and place them at the seeded location
      const player = await app.inject({
        method: "POST", url: "/api/auth/register",
        payload: { username: "Buyer", password: "hunter2hunter2" },
      });
      const playerToken = player.json().token;
      const buyerId = player.json().playerId;
      await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, buyerId));

      // First upsert (insert)
      const stock1 = await app.inject({
        method: "POST", url: "/api/admin/inventory/shop", headers: auth(),
        payload: { locationId, itemId, price: "500", stock: 10 },
      });
      expect(stock1.statusCode).toBe(204);

      // Second upsert (update)
      const stock2 = await app.inject({
        method: "POST", url: "/api/admin/inventory/shop", headers: auth(),
        payload: { locationId, itemId, price: "750", stock: 5 },
      });
      expect(stock2.statusCode).toBe(204);

      // Drive the PUBLIC shop route for the buyer's location
      const shop = await app.inject({
        method: "GET", url: "/api/shop",
        headers: { authorization: `Bearer ${playerToken}` },
      });
      expect(shop.statusCode).toBe(200);
      const shopItems = shop.json().items as Array<{
        itemId: string; name: string; price: string; stock: number;
      }>;
      expect(shopItems).toHaveLength(1);
      expect(shopItems[0].itemId).toBe(itemId);
      expect(shopItems[0].price).toBe("750");
      expect(shopItems[0].stock).toBe(5);
    });

    it("lists shop stock with location and item names", async () => {
      const locationId = uuidv7();
      await db.insert(locations).values({
        id: locationId, name: "Palermo",
        travelCost: 0n, travelCooldownSeconds: 0,
        bulletStock: 0, bulletCost: 0n,
      });

      const itemRes = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Lupara", itemType: "weapon", damageMin: 10, damageMax: 20 },
      });
      const itemId: string = itemRes.json().id;

      const stock = await app.inject({
        method: "POST", url: "/api/admin/inventory/shop", headers: auth(),
        payload: { locationId, itemId, price: "500", stock: 10 },
      });
      expect(stock.statusCode).toBe(204);

      const list = await app.inject({ method: "GET", url: "/api/admin/inventory/shop", headers: auth() });
      expect(list.statusCode).toBe(200);
      const rows = list.json().rows as Array<{
        locationId: string; locationName: string;
        itemId: string; itemName: string;
        price: string; stock: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].locationId).toBe(locationId);
      expect(rows[0].locationName).toBe("Palermo");
      expect(rows[0].itemId).toBe(itemId);
      expect(rows[0].itemName).toBe("Lupara");
      expect(rows[0].price).toBe("500");
      expect(rows[0].stock).toBe("10");
    });

    it("404s stocking an unknown item", async () => {
      const locationId = uuidv7();
      await db.insert(locations).values({
        id: locationId, name: "Palermo",
        travelCost: 0n, travelCooldownSeconds: 0,
        bulletStock: 0, bulletCost: 0n,
      });

      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/shop", headers: auth(),
        payload: { locationId, itemId: uuidv7(), price: "100", stock: 5 },
      });
      expect(res.statusCode).toBe(404);
    });

    it("404s stocking an unknown location", async () => {
      const itemRes = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Lupara", itemType: "weapon", damageMin: 10, damageMax: 20 },
      });
      const itemId: string = itemRes.json().id;

      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/shop", headers: auth(),
        payload: { locationId: uuidv7(), itemId, price: "100", stock: 5 },
      });
      expect(res.statusCode).toBe(404);
    });

    it("403s a non-admin", async () => {
      const p = await app.inject({
        method: "POST", url: "/api/auth/register",
        payload: { username: "Pleb", password: "hunter2hunter2" },
      });
      const res = await app.inject({
        method: "GET", url: "/api/admin/inventory/shop",
        headers: { authorization: `Bearer ${p.json().token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
