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

    // The regression this file exists to pin: the form and body schema used to
    // carry damageMin/damageMax/accuracy only, so the other five weapon stats
    // were frozen at WeaponEffectsSchema's defaults for anything an admin
    // created — unreachable from the UI for the life of the item.
    it("creates a weapon carrying every weapon stat", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: {
          name: "Tommy Gun", itemType: "weapon",
          damageMin: 12, damageMax: 30, accuracy: 40,
          bulletsPerShot: 6, critChance: 15, critMultiplier: 2.5,
          armorPierce: 8, minRankExp: 5000,
        },
      });
      expect(res.statusCode).toBe(201);
      const [row] = await db.select().from(items).where(eq(items.id, res.json().id));
      expect(row?.effects).toEqual({
        damageMin: 12, damageMax: 30, accuracy: 40,
        bulletsPerShot: 6, critChance: 15, critMultiplier: 2.5,
        armorPierce: 8, minRankExp: 5000,
      });
    });

    // The renderer posts every field in the form, blank ones as "". Left to
    // `z.coerce.number()` that reads as 0, and accuracy 0 is a weapon that
    // never hits — the opposite of the "unstated, let combat decide" the
    // optional field is for.
    it("treats a blank accuracy as absent rather than zero", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: {
          name: "Unstated", itemType: "weapon",
          damageMin: 5, damageMax: 9, accuracy: "",
          bulletsPerShot: "", critChance: "", critMultiplier: "",
          armorPierce: "", minRankExp: "",
        },
      });
      expect(res.statusCode).toBe(201);
      const [row] = await db.select().from(items).where(eq(items.id, res.json().id));
      expect(row?.effects).toEqual({
        damageMin: 5, damageMax: 9,
        bulletsPerShot: 1, critChance: 0, critMultiplier: 1,
        armorPierce: 0, minRankExp: 0,
      });
    });

    it("rejects a weapon whose critChance is above 100", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: {
          name: "Impossible", itemType: "weapon",
          damageMin: 1, damageMax: 2, critChance: 101,
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a weapon whose critMultiplier is below 1", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: {
          name: "Anti-crit", itemType: "weapon",
          damageMin: 1, damageMax: 2, critMultiplier: 0.5,
        },
      });
      expect(res.statusCode).toBe(400);
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

    // The listing used to carry one `effects` column holding JSON.stringify of
    // the jsonb, which the table view rendered as a wall of braces. Every stat
    // is its own column now, so the table is readable and each cell lines up
    // with the update form field that sets it.
    it("lists a weapon as one column per stat, with no JSON blob", async () => {
      const create = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: {
          name: "Lupara", itemType: "weapon",
          damageMin: 10, damageMax: 20, accuracy: 65,
          bulletsPerShot: 2, critChance: 10, critMultiplier: 1.5,
          armorPierce: 3, minRankExp: 100,
        },
      });
      expect(create.statusCode).toBe(201);
      const id: string = create.json().id;

      const list = await app.inject({ method: "GET", url: "/api/admin/inventory/items", headers: auth() });
      expect(list.statusCode).toBe(200);
      const rows = list.json().rows as Array<Record<string, string>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id,
        name: "Lupara",
        itemType: "weapon",
        damage: "10–20",
        accuracy: "65",
        bulletsPerShot: "2",
        critChance: "10",
        critMultiplier: "1.5",
        armorPierce: "3",
        minRankExp: "100",
        armor: "",
        heal: "",
      });
      expect(rows[0]).not.toHaveProperty("effects");
    });

    it("lists an armor item with the weapon stat cells blank", async () => {
      await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Kevlar Vest", itemType: "armor", armor: 30 },
      });
      const list = await app.inject({ method: "GET", url: "/api/admin/inventory/items", headers: auth() });
      const rows = list.json().rows as Array<Record<string, string>>;
      expect(rows[0]).toMatchObject({
        itemType: "armor", armor: "30",
        damage: "", accuracy: "", critMultiplier: "", heal: "",
      });
    });

    it("lists a consumable's heal", async () => {
      await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Medkit", itemType: "consumable", heal: 25 },
      });
      const list = await app.inject({ method: "GET", url: "/api/admin/inventory/items", headers: auth() });
      const rows = list.json().rows as Array<Record<string, string>>;
      expect(rows[0]).toMatchObject({ itemType: "consumable", heal: "25", damage: "", armor: "" });
    });

    // A V2-migrated weapon has no accuracy: `itemEffects` had no such column,
    // and combat fills it from its own setting at fire time. Absent must read
    // as absent, not as zero — a weapon that states accuracy 0 never hits.
    it("dashes the accuracy of a weapon that has none", async () => {
      await db.insert(items).values({
        id: uuidv7(), name: "Migrated Shiv", itemType: "weapon",
        effects: {
          damageMin: 4, damageMax: 6, bulletsPerShot: 1,
          critChance: 0, critMultiplier: 1, armorPierce: 0, minRankExp: 0,
        },
      });
      const list = await app.inject({ method: "GET", url: "/api/admin/inventory/items", headers: auth() });
      const rows = list.json().rows as Array<Record<string, string>>;
      expect(rows[0]).toMatchObject({ damage: "4–6", accuracy: "—" });
    });

    // `items.effects` is jsonb an earlier tool or a hand-edit can leave in a
    // shape the schema rejects. The listing must say so rather than render
    // blanks that read like a valid item with no stats.
    it("marks a known item type whose effects do not parse", async () => {
      await db.insert(items).values({
        id: uuidv7(), name: "Broken Gun", itemType: "weapon",
        effects: { damageMin: 10 },
      });
      const list = await app.inject({ method: "GET", url: "/api/admin/inventory/items", headers: auth() });
      const rows = list.json().rows as Array<Record<string, string>>;
      expect(rows[0]).toMatchObject({ name: "Broken Gun", damage: "invalid", accuracy: "" });
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

  // Items were create-only, so a seeded item — Rusty Pistol among them — could
  // never be rebalanced from the admin UI. This is the crimes/ranks update
  // pattern applied to items.
  describe("item update", () => {
    async function makeWeapon(): Promise<string> {
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Rusty Pistol", itemType: "weapon", damageMin: 8, damageMax: 18, accuracy: 55 },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id;
    }

    it("rewrites every weapon stat", async () => {
      const id = await makeWeapon();
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items/update", headers: auth(),
        payload: {
          id, itemType: "weapon",
          damageMin: 20, damageMax: 45, accuracy: 80,
          bulletsPerShot: 3, critChance: 25, critMultiplier: 3,
          armorPierce: 12, minRankExp: 9000,
        },
      });
      expect(res.statusCode).toBe(204);
      const [row] = await db.select().from(items).where(eq(items.id, id));
      expect(row?.effects).toEqual({
        damageMin: 20, damageMax: 45, accuracy: 80,
        bulletsPerShot: 3, critChance: 25, critMultiplier: 3,
        armorPierce: 12, minRankExp: 9000,
      });
    });

    it("renames an item", async () => {
      const id = await makeWeapon();
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items/update", headers: auth(),
        payload: { id, itemType: "weapon", name: "Polished Pistol", damageMin: 8, damageMax: 18 },
      });
      expect(res.statusCode).toBe(204);
      const [row] = await db.select().from(items).where(eq(items.id, id));
      expect(row?.name).toBe("Polished Pistol");
    });

    it("leaves the name alone when none is sent", async () => {
      const id = await makeWeapon();
      await app.inject({
        method: "POST", url: "/api/admin/inventory/items/update", headers: auth(),
        payload: { id, itemType: "weapon", damageMin: 8, damageMax: 18 },
      });
      const [row] = await db.select().from(items).where(eq(items.id, id));
      expect(row?.name).toBe("Rusty Pistol");
    });

    // Same reason as the blank-accuracy case: the form always posts `name`, so
    // a blank one must mean "leave it" and not rename the item to "".
    it("leaves the name alone when a blank one is sent", async () => {
      const id = await makeWeapon();
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items/update", headers: auth(),
        payload: { id, itemType: "weapon", name: "", damageMin: 8, damageMax: 18 },
      });
      expect(res.statusCode).toBe(204);
      const [row] = await db.select().from(items).where(eq(items.id, id));
      expect(row?.name).toBe("Rusty Pistol");
    });

    it("updates an armor item", async () => {
      const create = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Kevlar Vest", itemType: "armor", armor: 30 },
      });
      const id: string = create.json().id;
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items/update", headers: auth(),
        payload: { id, itemType: "armor", armor: 55 },
      });
      expect(res.statusCode).toBe(204);
      const [row] = await db.select().from(items).where(eq(items.id, id));
      expect(row?.effects).toEqual({ armor: 55 });
    });

    it("updates a consumable item", async () => {
      const create = await app.inject({
        method: "POST", url: "/api/admin/inventory/items", headers: auth(),
        payload: { name: "Medkit", itemType: "consumable", heal: 25 },
      });
      const id: string = create.json().id;
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items/update", headers: auth(),
        payload: { id, itemType: "consumable", heal: 60 },
      });
      expect(res.statusCode).toBe(204);
      const [row] = await db.select().from(items).where(eq(items.id, id));
      expect(row?.effects).toEqual({ heal: 60 });
    });

    // The form's item select lists every item regardless of type, so an admin
    // can point the armor form at a weapon. Writing `{ armor: n }` onto a
    // weapon would leave a row whose item_type and effects disagree, which
    // readEffects then reports as null and equipping refuses.
    it("400s writing armor stats onto a weapon", async () => {
      const id = await makeWeapon();
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items/update", headers: auth(),
        payload: { id, itemType: "armor", armor: 30 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("item_type_mismatch");
      const [row] = await db.select().from(items).where(eq(items.id, id));
      expect(row?.effects).toMatchObject({ damageMin: 8, damageMax: 18 });
    });

    it("404s an unknown item id", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items/update", headers: auth(),
        payload: { id: uuidv7(), itemType: "weapon", damageMin: 1, damageMax: 2 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("item_not_found");
    });

    it("400s damageMax below damageMin", async () => {
      const id = await makeWeapon();
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items/update", headers: auth(),
        payload: { id, itemType: "weapon", damageMin: 30, damageMax: 5 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("403s a non-admin", async () => {
      const id = await makeWeapon();
      const p = await app.inject({
        method: "POST", url: "/api/auth/register",
        payload: { username: "Pleb", password: "hunter2hunter2" },
      });
      const res = await app.inject({
        method: "POST", url: "/api/admin/inventory/items/update",
        headers: { authorization: `Bearer ${p.json().token}` },
        payload: { id, itemType: "weapon", damageMin: 1, damageMax: 2 },
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
