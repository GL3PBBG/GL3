import { FormValuesResponseSchema, PluginsPayloadSchema, TableRowsResponseSchema } from "@gl3/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, playerStats } from "../src/db/schema/index.js";
import { seedCrimes, seedLocations } from "../src/db/seed.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The three world-hook plugins' view-node pages (spec
 * 2026-09-18-core-view-pages-design §5): a client that renders a plugin page
 * from the view vocabulary — the Godot client does — must find a real view
 * behind each door, and every `source`/`action` in it must be a route this
 * boot actually serves — which these tests prove by fetching each one, not by
 * leaning on boot validation. Containment (a source under the plugin's own
 * basePaths) is a separate guarantee and belongs to
 * `plugin-validate.test.ts`; it did not even cover `keyValueSource` or
 * `meterSource` until this cluster closed that gap. `apps/web` is unaffected:
 * `PAGE_OVERRIDES` still wins there, so nothing here asserts anything about
 * the browser.
 */
const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

beforeAll(async () => {
  ({ app, close: closeServer, redis } = await bootTestServer());
  await subscriber.subscribe(GAME_EVENTS_CHANNEL);
});
beforeEach(async () => {
  await resetDb(db);
  await seedLocations(db);
  // The gl3 union is what bootTestServer() boots, so seed ITS crime set —
  // eight blended brave+cooldown+formula crimes, not the historical v2 three.
  await seedCrimes(db, "gl3");
});
afterAll(async () => { await closeServer(); await conn.end(); subscriber.disconnect(); });

const get = (url: string, token: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
const post = (url: string, token: string, payload?: unknown) =>
  app.inject({
    method: "POST", url, headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

describe("bank.index", () => {
  it("declares a real view whose sources are served", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const payload = PluginsPayloadSchema.parse((await get("/api/plugins", token)).json());
    const page = payload.pages.find((p) => p.id === "bank.index")!;
    expect(JSON.stringify(page.view)).toContain("GET /api/bank/summary");
    expect(JSON.stringify(page.view)).toContain("POST /api/bank/deposit");
    expect(JSON.stringify(page.view)).toContain("POST /api/bank/withdraw");

    await db.update(playerStats).set({ cash: 1500n, bank: 250n }).where(eq(playerStats.playerId, playerId));
    const summary = FormValuesResponseSchema.parse((await get("/api/bank/summary", token)).json());
    expect(summary.values).toMatchObject({ cash: "1500", bank: "250", account: "open" });

    expect((await post("/api/bank/deposit", token, { amount: "500" })).statusCode).toBe(200);
    const after = FormValuesResponseSchema.parse((await get("/api/bank/summary", token)).json());
    expect(after.values).toMatchObject({ cash: "1000", bank: "750" });
  });
});

describe("travel.index", () => {
  it("serves destination rows with state, cannotTravel and cooldownUntil", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const towns = await db.select({ id: locations.id, name: locations.name }).from(locations);
    const ny = towns.find((t) => t.name === "New York")!.id;
    const chicago = towns.find((t) => t.name === "Chicago")!.id;
    const miami = towns.find((t) => t.name === "Miami")!.id;
    await db.update(playerStats).set({ locationId: ny, cash: 10_000n }).where(eq(playerStats.playerId, playerId));
    await db.update(locations).set({ minLevel: 99 }).where(eq(locations.id, miami));

    const page = PluginsPayloadSchema.parse((await get("/api/plugins", token)).json())
      .pages.find((p) => p.id === "travel.index")!;
    expect(JSON.stringify(page.view)).toContain("GET /api/travel/destinations");
    expect(JSON.stringify(page.view)).toContain("POST /api/travel/:id");

    let rows = TableRowsResponseSchema.parse((await get("/api/travel/destinations", token)).json()).rows;
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by(ny)).toMatchObject({ state: "Here", cannotTravel: "true", cooldownUntil: "" });
    expect(by(miami)).toMatchObject({ state: "Locked · level 99", cannotTravel: "true" });
    expect(by(chicago)).toMatchObject({
      state: "Ready", cannotTravel: "false", cooldownUntil: "", travelCost: "100", combatMode: "open",
    });
    for (const r of rows) for (const v of Object.values(r)) expect(typeof v).toBe("string");

    expect((await post(`/api/travel/${chicago}`, token)).statusCode).toBe(200);
    rows = TableRowsResponseSchema.parse((await get("/api/travel/destinations", token)).json()).rows;
    expect(by(chicago).state).toBe("Here");
    expect(by(ny).state).toBe("On cooldown");
    expect(Date.parse(by(ny).cooldownUntil!)).toBeGreaterThan(Date.now());
    // The cooldown gates through cooldownKey, not disabledKey: the button
    // counts down in place rather than rendering flatly disabled.
    expect(by(ny).cannotTravel).toBe("false");
  });
});

describe("crimes.index", () => {
  it("serves crime rows and the last outcome", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const page = PluginsPayloadSchema.parse((await get("/api/plugins", token)).json())
      .pages.find((p) => p.id === "crimes.index")!;
    expect(JSON.stringify(page.view)).toContain("GET /api/crimes/rows");
    expect(JSON.stringify(page.view)).toContain("GET /api/crimes/last");
    expect(JSON.stringify(page.view)).toContain("POST /api/crimes/:id/commit");

    const empty = await get("/api/crimes/last", token);
    expect(empty.statusCode).toBe(404);
    expect(empty.json()).toEqual({ error: "no_crimes" });

    let rows = TableRowsResponseSchema.parse((await get("/api/crimes/rows", token)).json()).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const v of Object.values(r)) expect(typeof v).toBe("string");
      expect(r.chance).toMatch(/^(\d+(\.\d+)?%|formula)$/);
      expect(r.payout).toMatch(/^\d+–\d+$/);
      expect(r).toMatchObject({ cooldown: "", cooldownUntil: "", cannotCommit: "false" });
    }

    const first = rows[0]!;
    // The commit is 202 and a BullMQ job resolves it; the socket event is the
    // authoritative "it happened", so wait for it before reading back.
    const resolved = awaitOwnEvent(subscriber, playerId);
    expect((await post(`/api/crimes/${first.id}/commit`, token)).statusCode).toBe(202);
    const event = await resolved;
    expect(event.type).toBe("crime.resolved");

    rows = TableRowsResponseSchema.parse((await get("/api/crimes/rows", token)).json()).rows;
    // The cooldown gates through cooldownKey, not disabledKey — travel's
    // shape: the button counts down in place rather than flat-disabling.
    expect(rows[0]).toMatchObject({ cannotCommit: "false" });
    expect(Date.parse(rows[0]!.cooldownUntil!)).toBeGreaterThan(Date.now());
    expect(rows[0]!.cooldown).toBe(rows[0]!.cooldownUntil);

    const last = FormValuesResponseSchema.parse((await get("/api/crimes/last", token)).json());
    expect(last.values.crime).toBe(first.name);
    expect(["success", "failed"]).toContain(last.values.outcome);
    expect(last.values.payout).toMatch(/^\d+$/);
    expect(Date.parse(last.values.at!)).toBeGreaterThan(0);
  });
});

describe("inventory.shop rows", () => {
  it("serves string rows with cannotBuy, and buy-one decrements stock", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const page = PluginsPayloadSchema.parse((await get("/api/plugins", token)).json())
      .pages.find((p) => p.id === "inventory.shop")!;
    expect(page.path).toBe("/shop");
    expect(JSON.stringify(page.view)).toContain("GET /api/shop/rows");
    expect(JSON.stringify(page.view)).toContain("POST /api/shop/buy/:id");

    const towns = await db.select({ id: locations.id, name: locations.name }).from(locations);
    const ny = towns.find((t) => t.name === "New York")!.id;
    await db.update(playerStats).set({ locationId: ny, cash: 100n }).where(eq(playerStats.playerId, playerId));
    const cheap = uuidv7();
    const dear = uuidv7();
    await db.execute(sql`insert into items (id, name, item_type, effects) values
      (${cheap}, 'Knuckles', 'weapon', ${JSON.stringify({ power: 3 })}::jsonb),
      (${dear}, 'Vest', 'armor', ${JSON.stringify({ armor: 5 })}::jsonb)`);
    await db.execute(sql`insert into p_inventory_shop_stock (location_id, item_id, price, stock) values
      (${ny}, ${cheap}, 40::bigint, 2), (${ny}, ${dear}, 500::bigint, 1)`);

    let rows = TableRowsResponseSchema.parse((await get("/api/shop/rows", token)).json()).rows;
    const by = (id: string) => rows.find((r) => r.id === id)!;
    for (const r of rows) for (const v of Object.values(r)) expect(typeof v).toBe("string");
    expect(by(cheap)).toMatchObject({ name: "Knuckles", itemType: "weapon", price: "40", stock: "2", image: "", cannotBuy: "false" });
    expect(by(cheap).effects).toBe("power: 3");
    expect(by(dear)).toMatchObject({ price: "500", cannotBuy: "true" });

    const bought = await post(`/api/shop/buy/${cheap}`, token);
    expect(bought.statusCode).toBe(200);
    expect(bought.json()).toMatchObject({ itemId: cheap, qty: 1, stock: 1, cash: "60" });

    rows = TableRowsResponseSchema.parse((await get("/api/shop/rows", token)).json()).rows;
    expect(by(cheap)).toMatchObject({ stock: "1", cannotBuy: "false" });
    // 60 left, 40 more: one more buy empties the row and it disappears (stock > 0 filter).
    expect((await post(`/api/shop/buy/${cheap}`, token)).statusCode).toBe(200);
    rows = TableRowsResponseSchema.parse((await get("/api/shop/rows", token)).json()).rows;
    expect(rows.find((r) => r.id === cheap)).toBeUndefined();
    expect((await post(`/api/shop/buy/${cheap}`, token)).statusCode).toBe(409);
    expect((await post(`/api/shop/buy/${cheap}`, token)).json()).toMatchObject({ error: "insufficient_stock" });
  });
});

describe("casino.index", () => {
  it("declares a lobby view whose sources are served", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const [ny] = await db.select({ id: locations.id }).from(locations).where(eq(locations.name, "New York"));
    await db.update(playerStats).set({ locationId: ny!.id }).where(eq(playerStats.playerId, playerId));
    const page = PluginsPayloadSchema.parse((await get("/api/plugins", token)).json())
      .pages.find((p) => p.id === "casino.index")!;
    const view = JSON.stringify(page.view);
    expect(view).toContain("GET /api/casino/summary");
    expect(view).toContain("GET /api/casino/games/rows");
    expect(view).toContain("GET /api/casino/tables/rows");
    // Deliberately NO play/sit action: a view-node client cannot act on a hand,
    // and an unacted hand expires to a forfeit.
    expect(view).not.toContain("POST /api/casino");
    expect(FormValuesResponseSchema.parse((await get("/api/casino/summary", token)).json()).values.openHand).toBe("none");
    for (const url of ["/api/casino/games/rows", "/api/casino/tables/rows"]) {
      const rows = TableRowsResponseSchema.parse((await get(url, token)).json()).rows;
      for (const r of rows) for (const v of Object.values(r)) expect(typeof v).toBe("string");
    }
  });
});
