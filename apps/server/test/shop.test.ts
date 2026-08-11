import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

let app: FastifyInstance;
let closeServer: () => Promise<void>;

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
});

/** Registers a player and returns their id plus a bearer token. */
async function register(): Promise<{ id: string; token: string }> {
  const username = `shopper_${randomUUID().slice(0, 8)}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "correct horse battery staple" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json<{ playerId: string; token: string }>();
  return { id: body.playerId, token: body.token };
}

/** A location, an item, and one stock row for them. */
async function seedShop(price: bigint, stock: number): Promise<{ locationId: string; itemId: string }> {
  const locationId = uuidv7();
  const itemId = uuidv7();
  await db.execute(sql`
    insert into locations (id, name) values (${locationId}, ${"Shopville " + locationId.slice(0, 8)})`);
  await db.execute(sql`
    insert into items (id, name, item_type, effects)
    values (${itemId}, ${"Test Pistol " + itemId.slice(0, 8)}, 'weapon',
            ${JSON.stringify({ accuracy: 55, damageMin: 8, damageMax: 18 })}::jsonb)`);
  await db.execute(sql`
    insert into p_inventory_shop_stock (location_id, item_id, price, stock)
    values (${locationId}, ${itemId}, ${price.toString()}::bigint, ${stock})`);
  return { locationId, itemId };
}

async function moveTo(playerId: string, locationId: string): Promise<void> {
  await db.execute(sql`update player_stats set location_id = ${locationId} where player_id = ${playerId}`);
}

describe("GET /api/shop", () => {
  it("lists the stock at the caller's location, with money as a string", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(2500n, 10);
    await moveTo(player.id, locationId);

    const res = await app.inject({
      method: "GET",
      url: "/api/shop",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ locationId: string; items: { itemId: string; price: unknown; stock: number; effects: unknown }[] }>();
    expect(body.locationId).toBe(locationId);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.itemId).toBe(itemId);
    // Decimal string, never a JSON number.
    expect(body.items[0]?.price).toBe("2500");
    expect(body.items[0]?.stock).toBe(10);
    // Through readEffects, so the weapon defaults a migrated V2 item does not
    // carry are filled in for the client.
    expect(body.items[0]?.effects).toMatchObject({ accuracy: 55, bulletsPerShot: 1 });
  });

  it("hides a stock row whose item has been deleted", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(2500n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`delete from items where id = ${itemId}`);

    const res = await app.inject({
      method: "GET",
      url: "/api/shop",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it("answers 409 no_location for a player who is nowhere", async () => {
    const player = await register();
    const res = await app.inject({
      method: "GET",
      url: "/api/shop",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("no_location");
  });

  it("answers 401 without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/shop" });
    expect(res.statusCode).toBe(401);
  });
});
