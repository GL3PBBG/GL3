import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

let app: FastifyInstance;
let closeServer: () => Promise<void>;

afterAll(async () => {
  await closeServer?.();
  await conn.end();
  subscriber.disconnect();
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

  it("hides a zero-stock row while still showing stocked rows", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(2500n, 10);
    const outOfStock = await seedShop(500n, 5);
    await moveTo(player.id, locationId);
    // Move the second stock row to the same location so it competes in the
    // same listing.
    await db.execute(sql`
      update p_inventory_shop_stock set location_id = ${locationId}
      where item_id = ${outOfStock.itemId}`);
    await db.execute(sql`
      update p_inventory_shop_stock set stock = 0
      where item_id = ${outOfStock.itemId}`);

    const res = await app.inject({
      method: "GET",
      url: "/api/shop",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { itemId: string }[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.itemId).toBe(itemId);
  });

  it("answers 401 without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/shop" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/shop/buy", () => {
  const buy = (token: string, itemId: string, quantity: number) =>
    app.inject({
      method: "POST",
      url: "/api/shop/buy",
      headers: { authorization: `Bearer ${token}` },
      payload: { itemId, quantity },
    });

  it("debits cash, decrements stock, credits the item, and writes one ledger row", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(2500n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 10000 where player_id = ${player.id}`);

    const res = await buy(player.token, itemId, 2);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ cash: string; qty: number; stock: number }>();
    // 10000 - 2 * 2500. A decimal string, never a JSON number.
    expect(body.cash).toBe("5000");
    expect(body.qty).toBe(2);
    expect(body.stock).toBe(8);

    const owned = await db.execute<{ qty: number }>(
      sql`select qty from player_items where player_id = ${player.id} and item_id = ${itemId}`,
    );
    expect(owned[0]?.qty).toBe(2);

    // `applyBalanceChange` writes to `transactions` (the ledger table's real
    // name — `packages/plugin-sdk` and CLAUDE.md rule 3 both call it "the
    // ledger", but the schema is `apps/server/src/db/schema/economy.ts`'s
    // `transactions`).
    const ledger = await db.execute<{ amount: string; reason: string }>(
      sql`select amount::text as amount, reason from transactions where player_id = ${player.id}
          and reason = 'shop.purchase'`,
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.amount).toBe("-5000");
  });

  it("stacks onto an existing row rather than inserting a second one", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(100n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 10000 where player_id = ${player.id}`);

    expect((await buy(player.token, itemId, 1)).statusCode).toBe(200);
    const second = await buy(player.token, itemId, 3);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ qty: number }>().qty).toBe(4);

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from player_items where player_id = ${player.id}`,
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("publishes a purchased event to the buyer", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(100n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 10000 where player_id = ${player.id}`);

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    // Filtered by our own actorId: `game:events` is global across test files
    // and matching on type alone captures another file's traffic.
    const received = awaitOwnEvent(subscriber, player.id);
    expect((await buy(player.token, itemId, 1)).statusCode).toBe(200);
    const event = await received;
    expect(event.type).toBe("plugin.event");
    expect(event.actorId).toBe(player.id);
  });

  it("answers 409 not_sold_here for an item this location does not stock", async () => {
    const player = await register();
    const { locationId } = await seedShop(100n, 10);
    const elsewhere = await seedShop(100n, 10);
    await moveTo(player.id, locationId);

    const res = await buy(player.token, elsewhere.itemId, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("not_sold_here");
  });

  it("answers 409 insufficient_stock with what is available", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(100n, 2);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 10000 where player_id = ${player.id}`);

    const res = await buy(player.token, itemId, 3);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string; available: number }>()).toMatchObject({
      error: "insufficient_stock",
      available: 2,
    });
  });

  it("answers 409 insufficient_funds rather than 500", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(2500n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 100 where player_id = ${player.id}`);

    const res = await buy(player.token, itemId, 1);
    // Without the InsufficientFundsError catch this is a 500: the loader maps
    // only PluginError.
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("insufficient_funds");

    // …and nothing moved.
    const stock = await db.execute<{ stock: number }>(
      sql`select stock from p_inventory_shop_stock where item_id = ${itemId}`,
    );
    expect(stock[0]?.stock).toBe(10);
  });

  it("answers 409 no_location for a player who is nowhere", async () => {
    const player = await register();
    const { itemId } = await seedShop(100n, 10);
    const res = await buy(player.token, itemId, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("no_location");
  });

  it("rejects a non-positive quantity with 400", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(100n, 10);
    await moveTo(player.id, locationId);
    expect((await buy(player.token, itemId, 0)).statusCode).toBe(400);
  });

  it("answers 423 while jailed and while hospitalised", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(100n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 10000 where player_id = ${player.id}`);

    await db.execute(sql`update player_stats set jailed_until = now() + interval '1 hour'
                         where player_id = ${player.id}`);
    expect((await buy(player.token, itemId, 1)).statusCode).toBe(423);

    await db.execute(sql`update player_stats set jailed_until = null,
                         hospital_until = now() + interval '1 hour'
                         where player_id = ${player.id}`);
    expect((await buy(player.token, itemId, 1)).statusCode).toBe(423);
  });
});
