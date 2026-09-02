// Every boot here pins { profile: "v2" }: this file tests the attribute
// family's OPT-IN property (baselines without a pool, or a custom test
// pool plugin that would collide with the gl3 union's mccodes-attributes).
// The suite's default boot is the gl3 union — see helpers/server.ts.
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { coreActionCost, definePlugin, on, type PluginManifest } from "@gl3/plugin-sdk";
import { items, locations, playerItems, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

/**
 * Subscribes `combat.attack` to a flat 5-energy cost and nothing else — the
 * `combat.attack` analogue of `attributes-opt-in.test.ts`'s
 * `pricesCrimesEnergy`, kept local to this file per this task's brief (Task
 * 6's file is not imported from here). No `providesAttributes` here: this
 * plugin prices the action, it does not own the pool.
 */
const pricesAttackEnergy: PluginManifest = definePlugin({
  id: "attackenergycost",
  version: "1.0.0",
  basePaths: ["/api/attackenergycost"],
  filters: [on(coreActionCost, (_ctx, value) => (
    value.action === "combat.attack" ? { ...value, costs: { ...value.costs, energy: 5 } } : value
  ))],
});

/**
 * Puts attacker and target in the same fresh location with everything
 * `attackRoute`'s eligibility checks demand: both well above
 * `newbieExpThreshold` (default well under 100_000), neither jailed nor
 * hospitalised, no gang on either side (so `same_gang` cannot fire), and a
 * town left at its default `combat_mode` of `'open'` (so the
 * underground/detective-report gate never engages). Mirrors
 * `combat.test.ts`'s own `makeAttackable`, rebuilt locally per this task's
 * brief rather than imported — this file owns no shared fixture module with
 * `combat.test.ts` either.
 */
async function seedAttackable(playerIds: string[]): Promise<string> {
  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `loc-${locationId.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  await db
    .update(playerStats)
    .set({
      locationId,
      exp: 100_000n,
      // Routed (gl3-profile) boot: the newbie gate reads level, not exp.
      level: 100,
      bullets: 1000n,
      health: 100,
      gangId: null,
      jailedUntil: null,
      hospitalUntil: null,
    })
    .where(inArray(playerStats.playerId, playerIds));
  return locationId;
}

/** Seeds a pinned, always-hitting weapon (never backfires) and equips it. */
async function equipWeapon(playerId: string): Promise<void> {
  const id = uuidv7();
  await db.insert(items).values({
    id, name: `w-${id.slice(-8)}`, itemType: "weapon",
    effects: { accuracy: 100, damageMin: 5, damageMax: 5, backfireChance: 0 },
  });
  await db.insert(playerItems).values({ playerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: id }).where(eq(playerStats.playerId, playerId));
}

async function readAttributes(playerId: string): Promise<{ energy: number; energyMax: number; energyRegenAt: Date | null }> {
  const [row] = await db
    .select({ energy: playerStats.energy, energyMax: playerStats.energyMax, energyRegenAt: playerStats.energyRegenAt })
    .from(playerStats)
    .where(eq(playerStats.playerId, playerId));
  if (!row) throw new Error(`player_stats row missing for ${playerId}`);
  return row;
}

describe("combat.attack — priced (an attribute-cost plugin is installed)", () => {
  let app: FastifyInstance;
  let redis: Awaited<ReturnType<typeof bootTestServer>>["redis"];
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    await resetDb(db);
    if (!app) ({ app, redis, close: closeServer } = await bootTestServer({ profile: "v2", plugins: [pricesAttackEnergy] }));
  });
  afterAll(async () => { await closeServer(); });

  it("refuses an attack the player cannot pay for, and takes no state with it", async () => {
    // A freshly registered player has energy=0 (migration 0016's column
    // default) — insufficient for any positive cost with no grant.
    const { token, playerId: attackerId } = await registerVerifiedPlayer(
      { app, redis }, { remoteAddress: "10.9.2.1" },
    );
    const { playerId: targetId } = await registerVerifiedPlayer(
      { app, redis }, { remoteAddress: "10.9.2.2" },
    );
    await seedAttackable([attackerId, targetId]);
    await equipWeapon(attackerId);
    const targetBefore = await readAttributes(targetId);

    const res = await app.inject({
      method: "POST", url: `/api/combat/attack/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_energy");
    // Refused before the first mutation of game state: bullets untouched,
    // target's health untouched.
    const [attackerRow] = await db.select().from(playerStats).where(eq(playerStats.playerId, attackerId));
    expect(attackerRow?.bullets).toBe(1000n);
    const targetAfter = await readAttributes(targetId);
    expect(targetAfter).toEqual(targetBefore);
  });

  it("debits the priced amount from an attacker who can pay", async () => {
    const { token, playerId: attackerId } = await registerVerifiedPlayer(
      { app, redis }, { remoteAddress: "10.9.2.3" },
    );
    const { playerId: targetId } = await registerVerifiedPlayer(
      { app, redis }, { remoteAddress: "10.9.2.4" },
    );
    await seedAttackable([attackerId, targetId]);
    await equipWeapon(attackerId);
    // Grant energy directly — no plugin in this suite declares
    // `providesAttributes`, so there is no regen decl to seed a max from
    // (`pricesAttackEnergy` only subscribes to `coreActionCost`, it does not
    // own the pool). Setting the row directly is the simplest way to give
    // this attacker something to spend.
    await db.update(playerStats).set({ energy: 10, energyMax: 10 }).where(eq(playerStats.playerId, attackerId));

    const res = await app.inject({
      method: "POST", url: `/api/combat/attack/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const after = await readAttributes(attackerId);
    expect(after.energy).toBe(5);
  });
});

describe("combat.attack — opt-out baseline (no attribute plugin installed)", () => {
  let app: FastifyInstance;
  let redis: Awaited<ReturnType<typeof bootTestServer>>["redis"];
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    await resetDb(db);
    if (!app) ({ app, redis, close: closeServer } = await bootTestServer({ profile: "v2" }));
  });
  afterAll(async () => { await closeServer(); });

  it("attacks for free and writes nothing to the attribute columns", async () => {
    const { token, playerId: attackerId } = await registerVerifiedPlayer(
      { app, redis }, { remoteAddress: "10.9.2.5" },
    );
    const { playerId: targetId } = await registerVerifiedPlayer(
      { app, redis }, { remoteAddress: "10.9.2.6" },
    );
    await seedAttackable([attackerId, targetId]);
    await equipWeapon(attackerId);

    const res = await app.inject({
      method: "POST", url: `/api/combat/attack/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const after = await readAttributes(attackerId);
    expect(after.energyMax).toBe(0);
    expect(after.energyRegenAt).toBeNull();
  });
});
