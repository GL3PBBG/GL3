import { RepairResponseSchema, WeaponConditionDtoSchema } from "@gl3/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { items, locations, playerItems, playerStats, settings, transactions } from "../src/db/schema/index.js";
import { weaponCondition } from "./helpers/plugin-tables.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The gunsmith: `GET /api/combat/weapon` (read-only condition report) and
 * `POST /api/combat/repair` (pays down wear). Uses the same reboot-on-
 * `setSetting` scaffolding as `combat-backfire.test.ts`, for the same
 * reason: `repair.cost_per_point` is read from a boot-time settings
 * snapshot, so a plain `db.insert(settings)` is invisible to an
 * already-running app.
 */
const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let player: string;
let weaponId: string;
let unownedWeaponId: string;
let ownedArmorId: string;

async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settings).values({ key, value });
  await closeServer();
  ({ app, close: closeServer } = await bootTestServer());
}

const statsOf = async (playerId: string) => {
  const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
  return row;
};

const get = (bearerToken: string, url: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${bearerToken}` } });

const post = (bearerToken: string, url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${bearerToken}` } });

beforeEach(async () => {
  await resetDb(db);
  if (app) await closeServer();
  ({ app, close: closeServer } = await bootTestServer());

  const registerRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Ren", password: "hunter2hunter2" },
  });
  ({ token, playerId: player } = registerRes.json());

  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `loc-${locationId.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  // player_stats.cash defaults to 0 on registration; the affordability test
  // sets its own cost so high that this default would pass trivially, so
  // every other test needs enough cash for a full 400-cost repair.
  await db.update(playerStats).set({ locationId, cash: 1_000_000n }).where(eq(playerStats.playerId, player));

  weaponId = uuidv7();
  await db.insert(items).values({
    id: weaponId, name: `w-${weaponId.slice(-8)}`, itemType: "weapon",
    effects: { damageMin: 1, damageMax: 5, backfireChance: 0 },
  });
  await db.insert(playerItems).values({ playerId: player, itemId: weaponId, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: weaponId }).where(eq(playerStats.playerId, player));

  // Owned but not equipped, and not a weapon: refused by the type check, not
  // the ownership check.
  ownedArmorId = uuidv7();
  await db.insert(items).values({
    id: ownedArmorId, name: `a-${ownedArmorId.slice(-8)}`, itemType: "armor",
    effects: { armor: 5 },
  });
  await db.insert(playerItems).values({ playerId: player, itemId: ownedArmorId, qty: 1 });

  // A real weapon item, but never granted to this player — no playerItems row.
  unownedWeaponId = uuidv7();
  await db.insert(items).values({
    id: unownedWeaponId, name: `w2-${unownedWeaponId.slice(-8)}`, itemType: "weapon",
    effects: { damageMin: 1, damageMax: 5, backfireChance: 0 },
  });
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("GET /api/combat/weapon", () => {
  it("reports the equipped weapon's condition and its repair cost", async () => {
    await setSetting("combat.repair.cost_per_point", "10");
    await db.insert(weaponCondition).values({
      playerId: player, itemId: weaponId, condition: 60, updatedAt: new Date(),
    });

    const dto = WeaponConditionDtoSchema.parse((await get(token, "/api/combat/weapon")).json());
    expect(dto.itemId).toBe(weaponId);
    expect(dto.condition).toBe(60);
    expect(dto.repairCost).toBe("400");
  });

  it("reports fists as pristine, zero-chance and free", async () => {
    await db.update(playerStats).set({ weaponItemId: null }).where(eq(playerStats.playerId, player));
    const dto = WeaponConditionDtoSchema.parse((await get(token, "/api/combat/weapon")).json());
    expect(dto).toEqual({
      itemId: null, name: null, condition: 100, backfireChance: 0, repairCost: "0",
    });
  });
});

describe("POST /api/combat/repair", () => {
  it("charges cost_per_point per point restored and sets condition to 100", async () => {
    await setSetting("combat.repair.cost_per_point", "10");
    await db.insert(weaponCondition).values({
      playerId: player, itemId: weaponId, condition: 60, updatedAt: new Date(),
    });
    const before = (await statsOf(player)).cash;

    const res = await post(token, "/api/combat/repair", { itemId: weaponId });
    expect(res.statusCode).toBe(200);
    expect(RepairResponseSchema.parse(res.json())).toEqual({ condition: 100, cost: "400" });

    expect((await statsOf(player)).cash).toBe(before - 400n);
    const [row] = await db.select().from(weaponCondition)
      .where(and(eq(weaponCondition.playerId, player), eq(weaponCondition.itemId, weaponId)));
    expect(row?.condition).toBe(100);
  });

  it("writes exactly one ledger row for the repair", async () => {
    await setSetting("combat.repair.cost_per_point", "10");
    await db.insert(weaponCondition).values({
      playerId: player, itemId: weaponId, condition: 60, updatedAt: new Date(),
    });
    await post(token, "/api/combat/repair", { itemId: weaponId });

    const rows = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, player), eq(transactions.reason, "combat.repair")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(-400n);
  });

  it("is a no-op on a pristine weapon, with no charge and no ledger row", async () => {
    const before = (await statsOf(player)).cash;
    const res = await post(token, "/api/combat/repair", { itemId: weaponId });
    expect(res.statusCode).toBe(204);
    expect((await statsOf(player)).cash).toBe(before);

    const rows = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, player), eq(transactions.reason, "combat.repair")));
    expect(rows).toHaveLength(0);
    const [row] = await db.select().from(weaponCondition)
      .where(and(eq(weaponCondition.playerId, player), eq(weaponCondition.itemId, weaponId)));
    expect(row).toBeUndefined();
  });

  it("refuses when the player cannot afford it, moving no money", async () => {
    await setSetting("combat.repair.cost_per_point", "1000000");
    await db.insert(weaponCondition).values({
      playerId: player, itemId: weaponId, condition: 10, updatedAt: new Date(),
    });
    const before = (await statsOf(player)).cash;

    const res = await post(token, "/api/combat/repair", { itemId: weaponId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_funds" });
    expect((await statsOf(player)).cash).toBe(before);
  });

  it("refuses an item the player does not own", async () => {
    const res = await post(token, "/api/combat/repair", { itemId: unownedWeaponId });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "weapon_not_found" });
  });

  it("refuses a non-weapon the player does own", async () => {
    const res = await post(token, "/api/combat/repair", { itemId: ownedArmorId });
    expect(res.statusCode).toBe(404);
  });

  it("repairs an owned weapon that is not equipped", async () => {
    await db.update(playerStats).set({ weaponItemId: null }).where(eq(playerStats.playerId, player));
    await db.insert(weaponCondition).values({
      playerId: player, itemId: weaponId, condition: 50, updatedAt: new Date(),
    });
    const res = await post(token, "/api/combat/repair", { itemId: weaponId });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a non-uuid itemId at the boundary", async () => {
    const res = await post(token, "/api/combat/repair", { itemId: "not-a-uuid" });
    expect(res.statusCode).toBe(400);
  });
});
