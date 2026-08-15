import combatPlugin from "@gl3/plugin-combat";
import { PluginError } from "@gl3/plugin-sdk";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import {
  gangMembers,
  gangs,
  items,
  locations,
  playerItems,
  players,
  playerStats,
  ranks,
  settings,
} from "../src/db/schema/index.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { combatLog } from "./helpers/plugin-tables.js";
import { callPluginRoute } from "./helpers/plugin-route.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
// Only the two callPluginRoute tests below use these; every other test in the
// file goes through `app.inject`. The prefix is run-unique so nothing here can
// zadd into the shared, global `leaderboard:*` keys.
const redis = createRedis(loadConfig(process.env).redisUrl);
const leaderboardPrefix = `combat-test-${uuidv7()}`;
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let attackerToken: string;
let attackerId: string;
let targetId: string;

/**
 * Puts every given player in the same, fresh location with enough exp to
 * clear newbie protection. Defaults to the module-level attacker/target pair
 * when called with no arguments — every pre-existing call site in this file
 * relies on that default. Variadic (not two fixed ids) so a single call can
 * co-locate more than two players atomically: calling it once per pair would
 * each time mint a NEW location and silently move the shared party out of the
 * previous pair's location, which is not "same location" for anyone but the
 * last pair.
 */
async function makeAttackable(...ids: string[]): Promise<string> {
  const players_ = ids.length > 0 ? ids : [attackerId, targetId];
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
      bullets: 1000n,
      health: 100,
      gangId: null,
      jailedUntil: null,
      hospitalUntil: null,
    })
    .where(inArray(playerStats.playerId, players_));
  return locationId;
}

/**
 * Seeds an item and equips it as `weapon_item_id`. `itemType` is a parameter
 * because the route's unarmed fallback fires on a wrong-typed item as well as
 * a malformed one, and both branches need proving.
 */
async function equipWeapon(
  playerId: string,
  effects: Record<string, unknown>,
  itemType = "weapon",
): Promise<string> {
  const id = uuidv7();
  // `backfireChance: 0` is spread FIRST so a caller can still override it.
  // Without it every weapon here inherits `combat.backfire.base_chance`,
  // whose default is 2 — a 2% chance per shot that the route returns early
  // with no hit, no kill, no payout and no ledger row. That is correct
  // gameplay and catastrophic as a test default: it makes every assertion
  // on a connecting shot in this file fail roughly one run in forty, and
  // this file fires ~25 of them. It belongs beside `accuracy: 100` — the
  // same kind of knob, pinned for the same reason.
  await db.insert(items).values({
    id, name: `w-${id.slice(-8)}`, itemType,
    effects: { backfireChance: 0, ...effects },
  });
  await db.insert(playerItems).values({ playerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: id }).where(eq(playerStats.playerId, playerId));
  return id;
}

const attack = (id: string) =>
  app.inject({
    method: "POST",
    url: `/api/combat/attack/${id}`,
    headers: { authorization: `Bearer ${attackerToken}` },
  });

/**
 * Registers a fresh player and returns their id, bearer token and username.
 * POST /api/auth/register is rate-limited to 5/hour/IP
 * (`auth/routes.ts:51`), and the outer `beforeEach` above already spends 2 of
 * those 5 registering the module-level attacker/target before every test
 * body runs — so a single test has 3 of its own `register()` calls to spend,
 * not 5. A test that needs more players than that should use `makeStranger`
 * for any of them that never need to authenticate.
 */
async function register(): Promise<{ id: string; token: string; username: string }> {
  const username = `p-${uuidv7().slice(-8)}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  const body = res.json<{ token: string; playerId: string; username: string }>();
  return { id: body.playerId, token: body.token, username: body.username };
}

/**
 * Inserts a bare player + stats row directly, bypassing both password
 * hashing and the registration rate limit above. Used for targets that are
 * only ever read, never authenticated as, in a test — a test needing several
 * such players in one body would otherwise blow the register() budget.
 */
async function makeStranger(): Promise<{ id: string; username: string }> {
  const id = uuidv7();
  const username = `s-${id.slice(-8)}`;
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return { id, username };
}

const bulletsOf = async (playerId: string): Promise<bigint | undefined> => {
  const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
  return row?.bullets;
};

// No Redis cooldown sweep here, deliberately. The attacker's cooldown key is
// `cooldown:combat.attack:<attackerId>` and `attackerId` is a fresh uuidv7 on
// every registration (auth/routes.ts:58), so each test below claims a key no
// previous test has ever touched. A sweep would clear nothing. The register
// rate-limit buckets ARE shared across the file and ARE swept — by the
// rate-limit-isolation setupFile, not by anything here.
beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  const attacker = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Sal", password: "hunter2hunter2" },
  });
  ({ token: attackerToken, playerId: attackerId } = attacker.json());

  const target = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Vito", password: "hunter2hunter2" },
  });
  ({ playerId: targetId } = target.json());
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  // Targeted DEL of this run's own namespaced keys, never FLUSHDB.
  await redis.del(`${leaderboardPrefix}:cash`, `${leaderboardPrefix}:bank`, `${leaderboardPrefix}:exp`);
  redis.disconnect();
  subscriber.disconnect();
});

/** Seeds an armor item and equips it on `playerId`. Returns the item id. */
async function equipArmor(playerId: string, armor: number): Promise<string> {
  const id = uuidv7();
  await db.insert(items).values({
    id,
    name: `a-${id.slice(-8)}`,
    itemType: "armor",
    effects: { armor },
  });
  await db.insert(playerItems).values({ playerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ armorItemId: id }).where(eq(playerStats.playerId, playerId));
  return id;
}

const healthOf = async (playerId: string): Promise<number | undefined> => {
  const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
  return row?.health;
};

describe("POST /api/combat/attack/:targetId — legality", () => {
  it("400s an attack on yourself", async () => {
    await makeAttackable();
    const res = await attack(attackerId);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "self_attack" });
  });

  it("404s an unknown target", async () => {
    await makeAttackable();
    const res = await attack(uuidv7());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "no_such_target" });
  });

  it("409s a hospitalised target", async () => {
    await makeAttackable();
    await db
      .update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 60_000), health: 0 })
      .where(eq(playerStats.playerId, targetId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "target_hospitalised" });
  });

  it("409s a jailed target", async () => {
    await makeAttackable();
    await db
      .update(playerStats)
      .set({ jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, targetId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "target_jailed" });
  });

  /**
   * The attacker's own sentence, re-checked INSIDE the transaction.
   *
   * `app.inject` cannot prove this: the loader gate (`plugins/routes.ts:39`)
   * answers 423 before the handler is ever entered, so an in-handler check
   * that did not exist would look exactly the same on the wire.
   * `callPluginRoute` runs no gate, which is why these two go through it —
   * they fail if and only if the handler itself stops checking.
   *
   * The window is real: the gate runs before the transaction, so between it
   * and `tx.locks.player` the victim's gangmate can hospitalise or jail the
   * attacker, and the shot fires anyway.
   */
  it("423s an attacker hospitalised after the gate ran — checked in the handler", async () => {
    await makeAttackable();
    await db
      .update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 60_000), health: 0 })
      .where(eq(playerStats.playerId, attackerId));

    await expect(
      callPluginRoute(combatPlugin, "POST", "/api/combat/attack/:targetId", {
        db, redis, leaderboardPrefix, playerId: attackerId, params: { targetId },
      }),
    ).rejects.toMatchObject({ code: "hospitalised", status: 423 });
    // Not just the right error: the shot must not have happened. Bullets are
    // debited before the roll, so an unchanged count is what proves it.
    expect(await bulletsOf(attackerId)).toBe(1000n);
    expect(await healthOf(targetId)).toBe(100);
  });

  it("423s an attacker jailed after the gate ran — checked in the handler", async () => {
    await makeAttackable();
    await db
      .update(playerStats)
      .set({ jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, attackerId));

    await expect(
      callPluginRoute(combatPlugin, "POST", "/api/combat/attack/:targetId", {
        db, redis, leaderboardPrefix, playerId: attackerId, params: { targetId },
      }),
    ).rejects.toMatchObject({ code: "jailed", status: 423 });
    expect(await bulletsOf(attackerId)).toBe(1000n);
    expect(await healthOf(targetId)).toBe(100);
  });

  it("lets an attack through once the ATTACKER's own sentence has elapsed", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 10, damageMax: 10 });
    // Already expired: the handler settles it under the lock rather than
    // 423ing on a sentence that has run out.
    await db
      .update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() - 1000), health: 0 })
      .where(eq(playerStats.playerId, attackerId));

    const result = await callPluginRoute(combatPlugin, "POST", "/api/combat/attack/:targetId", {
      db, redis, leaderboardPrefix, playerId: attackerId, params: { targetId },
    });

    expect(result).toMatchObject({ body: { hit: true } });
    expect(await healthOf(targetId)).toBe(90);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, attackerId));
    expect(row?.hospitalUntil).toBeNull();
    // Settled, not merely ignored: health is restored to the rank max.
    expect(row?.health).toBeGreaterThan(0);
  });

  it("409s a target in another location", async () => {
    await makeAttackable();
    const elsewhere = uuidv7();
    await db.insert(locations).values({
      id: elsewhere,
      name: `far-${elsewhere.slice(-8)}`,
      travelCost: 0n,
      travelCooldownSeconds: 60,
      bulletStock: 0,
      bulletCost: 1n,
    });
    await db
      .update(playerStats)
      .set({ locationId: elsewhere })
      .where(eq(playerStats.playerId, targetId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "target_elsewhere" });
  });

  it("409s a gang mate", async () => {
    await makeAttackable();
    const gangId = uuidv7();
    await db.insert(gangs).values({
      id: gangId,
      name: `g-${gangId.slice(-8)}`,
      bossPlayerId: attackerId,
    });
    await db.insert(gangMembers).values([
      { gangId, playerId: attackerId },
      { gangId, playerId: targetId },
    ]);
    await db
      .update(playerStats)
      .set({ gangId })
      .where(inArray(playerStats.playerId, [attackerId, targetId]));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "same_gang" });
  });

  it("409s when the TARGET is below the newbie threshold", async () => {
    await makeAttackable();
    await db.update(playerStats).set({ exp: 0n }).where(eq(playerStats.playerId, targetId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "protected" });
  });

  it("409s when the ATTACKER is below the newbie threshold — protection is mutual", async () => {
    await makeAttackable();
    await db.update(playerStats).set({ exp: 0n }).where(eq(playerStats.playerId, attackerId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "protected" });
  });

  it("409s when the attacker is out of bullets", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, {
      accuracy: 100,
      damageMin: 1,
      damageMax: 1,
      bulletsPerShot: 5,
    });
    await db.update(playerStats).set({ bullets: 4n }).where(eq(playerStats.playerId, attackerId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_bullets" });
  });

  it("lets an attack through once the target's hospital sentence has elapsed", async () => {
    // The whole reason settleTargetHospital exists: an elapsed sentence that
    // is only settled by the VICTIM's next request leaves them sitting at 0
    // health, attackable, and one hit from dying again.
    await makeAttackable();
    const rankId = uuidv7();
    await db.insert(ranks).values({
      id: rankId,
      name: `r-${rankId.slice(-8)}`,
      expRequired: 0n,
      maxHealth: 150,
    });
    await db
      .update(playerStats)
      .set({ rankId, hospitalUntil: new Date(Date.now() - 1000), health: 0 })
      .where(eq(playerStats.playerId, targetId));
    // Pinned, because the shot that follows the settle is a real one now. Left
    // unarmed this asserted an exact health after random 1-5 damage behind a
    // 25% hit chance, so it passed roughly three runs in four — green when the
    // shot missed, and only honest by luck.
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 10, damageMax: 10 });

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, targetId));
    expect(row?.hospitalUntil).toBeNull();
    // 150, not 100: healed to the rank's maxHealth by the settle, then shot.
    // A target that was never settled would read 0 here, not 140.
    expect(row?.health).toBe(140);
  });

  it("429s a second attack inside the cooldown", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 1, damageMax: 1 });
    const first = await attack(targetId);
    expect(first.statusCode).toBe(200);

    const second = await attack(targetId);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("burns the cooldown even when the attack is illegal", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 1, damageMax: 1 });
    await db
      .update(playerStats)
      .set({ jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, targetId));

    expect((await attack(targetId)).statusCode).toBe(409);

    // Deliberate: releasing on a 4xx would be a check-then-act on Redis, and
    // keeping it denies a free probe for scanning who is attackable.
    await db
      .update(playerStats)
      .set({ jailedUntil: null })
      .where(eq(playerStats.playerId, targetId));
    expect((await attack(targetId)).statusCode).toBe(429);
  });

  it("debits bullets on a miss", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, {
      accuracy: 0,
      damageMin: 5,
      damageMax: 5,
      bulletsPerShot: 3,
    });
    await db.update(playerStats).set({ bullets: 10n }).where(eq(playerStats.playerId, attackerId));

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hit: false, damage: 0, bulletsSpent: 3 });
    expect(await bulletsOf(attackerId)).toBe(7n);
  });

  it("falls back to the unarmed profile when nothing is equipped", async () => {
    await makeAttackable();
    await db.update(playerStats).set({ bullets: 10n }).where(eq(playerStats.playerId, attackerId));

    const res = await attack(targetId);

    // The unarmed default is one bullet per shot (combat.unarmed.bullets_per_shot).
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bulletsSpent: 1 });
    expect(await bulletsOf(attackerId)).toBe(9n);
  });

  it("falls back to unarmed for a malformed weapon rather than 500ing", async () => {
    // items.effects is admin-editable jsonb — an external boundary. The 7 in
    // bulletsPerShot is the discriminator: seeing 1 back proves the parse
    // failed and the unarmed profile was used, not this row.
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: "very", damageMin: 1, bulletsPerShot: 7 });
    await db.update(playerStats).set({ bullets: 10n }).where(eq(playerStats.playerId, attackerId));

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bulletsSpent: 1 });
    expect(await bulletsOf(attackerId)).toBe(9n);
  });

  it("falls back to unarmed when weapon_item_id points at a non-weapon", async () => {
    await makeAttackable();
    await equipWeapon(
      attackerId,
      { accuracy: 100, damageMin: 1, damageMax: 1, bulletsPerShot: 9 },
      "armor",
    );
    await db.update(playerStats).set({ bullets: 10n }).where(eq(playerStats.playerId, attackerId));

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bulletsSpent: 1 });
    expect(await bulletsOf(attackerId)).toBe(9n);
  });
});

describe("POST /api/combat/attack/:targetId — resolution", () => {
  it("lands a pinned hit and reduces the target's health", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 25, damageMax: 25 });

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hit: true,
      crit: false,
      damage: 25,
      armorAbsorbed: 0,
      targetHealth: 75,
      targetKilled: false,
      payout: "0",
      bulletsSpent: 1,
    });
    expect(await healthOf(targetId)).toBe(75);
  });

  it("subtracts the target's equipped armor", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 30, damageMax: 30 });
    await equipArmor(targetId, 12);

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ hit: true, damage: 18, armorAbsorbed: 12, targetHealth: 82 });
    expect(await healthOf(targetId)).toBe(82);
  });

  it("reports a fully-absorbed hit as a hit with zero damage, not a miss", async () => {
    // "Your armor held" is different information from "he missed" — and the
    // health UPDATE is skipped entirely on a zero-damage hit.
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 5, damageMax: 5 });
    await equipArmor(targetId, 99);

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ hit: true, damage: 0, armorAbsorbed: 5, targetHealth: 100 });
    expect(await healthOf(targetId)).toBe(100);
  });

  it("applies armorPierce against the target's armor", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, {
      accuracy: 100,
      damageMin: 30,
      damageMax: 30,
      armorPierce: 10,
    });
    await equipArmor(targetId, 12);

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ damage: 28, armorAbsorbed: 2, targetHealth: 72 });
  });

  it("ignores a non-armor item in the armor slot rather than 500ing", async () => {
    // Same external-boundary reasoning as the weapon fallback: armor_item_id
    // is an unconstrained FK to items and the jsonb is admin-editable. Armor
    // 0 is the discriminator — a full 30 through means the row was ignored.
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 30, damageMax: 30 });
    const junk = uuidv7();
    await db.insert(items).values({
      id: junk,
      name: `j-${junk.slice(-8)}`,
      itemType: "consumable",
      effects: { armor: 25 },
    });
    await db.insert(playerItems).values({ playerId: targetId, itemId: junk, qty: 1 });
    await db.update(playerStats).set({ armorItemId: junk }).where(eq(playerStats.playerId, targetId));

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ damage: 30, armorAbsorbed: 0, targetHealth: 70 });
  });

  it("crits when critChance is pinned to 100", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, {
      accuracy: 100,
      damageMin: 20,
      damageMax: 20,
      critChance: 100,
      critMultiplier: 2,
    });

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ crit: true, damage: 40, targetHealth: 60 });
  });

  it("blunts a crit with armor rather than letting the crit bypass it", async () => {
    // Crit multiplies BEFORE armor subtracts: 20 x 2 = 40, less 15 armor = 25.
    // The other order (armor first) would give (20-15) x 2 = 10.
    await makeAttackable();
    await equipWeapon(attackerId, {
      accuracy: 100,
      damageMin: 20,
      damageMax: 20,
      critChance: 100,
      critMultiplier: 2,
    });
    await equipArmor(targetId, 15);

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ crit: true, damage: 25, armorAbsorbed: 15 });
  });

  it("uses the unarmed profile when nothing is equipped", async () => {
    await makeAttackable();

    const res = await attack(targetId);

    // Unarmed defaults: accuracy 25, damage 1-5, 1 bullet. The outcome is
    // random, so assert only the invariants that hold either way — and the
    // health readback, which ties the body to the row and is what stops this
    // passing against a stub that always returns zero.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bulletsSpent).toBe(1);
    expect(body.damage).toBeGreaterThanOrEqual(0);
    expect(body.damage).toBeLessThanOrEqual(5);
    expect(body.hit).toBe(body.damage > 0 || body.armorAbsorbed > 0);
    expect(await healthOf(targetId)).toBe(100 - body.damage);
  });

  it("fills a V2-migrated weapon's missing accuracy from the settings default", async () => {
    // The case `combat.default_weapon_accuracy` exists for. V2's `itemEffects`
    // has no accuracy column at all, so every migrated weapon arrives without
    // one. Before this was wired, the missing field failed the zod parse and
    // the weapon fell back to UNARMED — the player lost the gun's damage too,
    // silently, with the setting sitting unread in the table.
    //
    // 100 makes the shot deterministic; a flat 30-30 damage range separates
    // "fired the weapon" (30) from "fell back to unarmed" (1-5) unambiguously.
    await makeAttackable();
    await equipWeapon(attackerId, { damageMin: 30, damageMax: 30 });
    await db.insert(settings).values({ key: "combat.default_weapon_accuracy", value: "100" });

    const { app: freshApp, close } = await bootTestServer();
    try {
      const res = await freshApp.inject({
        method: "POST",
        url: `/api/combat/attack/${targetId}`,
        headers: { authorization: `Bearer ${attackerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ hit: true, damage: 30, targetHealth: 70 });
    } finally {
      await close();
    }
  });

  it("prefers a weapon's own accuracy over the settings default", async () => {
    // The other half: the default is a BACKFILL, not an override. With the
    // default pinned to 0 an item that carries its own accuracy must still
    // fire — otherwise wiring the fallback would have quietly disarmed every
    // weapon that was already correct.
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 30, damageMax: 30 });
    await db.insert(settings).values({ key: "combat.default_weapon_accuracy", value: "0" });

    const { app: freshApp, close } = await bootTestServer();
    try {
      const res = await freshApp.inject({
        method: "POST",
        url: `/api/combat/attack/${targetId}`,
        headers: { authorization: `Bearer ${attackerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ hit: true, damage: 30 });
    } finally {
      await close();
    }
  });

  it("reads the unarmed profile from the settings table", async () => {
    // The test the settings layer did not have. `readCombatSettings`'s own
    // tests hand it a stub `get`, so they answer whatever they are asked and
    // cannot see the SDK's `<pluginId>.` prefix. Combat asked for
    // `combat.unarmed.accuracy`, the SDK looked up
    // `combat.combat.unarmed.accuracy`, and every setting silently fell back
    // to its default. Only a real request against a real row catches that.
    //
    // Rows are prefixed; the reader asks bare. Pinning accuracy to 100 also
    // makes the otherwise-random unarmed shot deterministic.
    await makeAttackable();
    await db.insert(settings).values([
      { key: "combat.unarmed.accuracy", value: "100" },
      { key: "combat.unarmed.damage_min", value: "4" },
      { key: "combat.unarmed.damage_max", value: "4" },
      { key: "combat.unarmed.bullets_per_shot", value: "2" },
    ]);
    // Settings are read into a snapshot at boot, so the row must predate the
    // server this request runs against.
    const { app: freshApp, close } = await bootTestServer();
    try {
      const res = await freshApp.inject({
        method: "POST",
        url: `/api/combat/attack/${targetId}`,
        headers: { authorization: `Bearer ${attackerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        hit: true,
        damage: 4,
        targetHealth: 96,
        bulletsSpent: 2,
      });
    } finally {
      await close();
    }
  });

  it("logs a hit", async () => {
    await makeAttackable();
    const weaponId = await equipWeapon(attackerId, {
      accuracy: 100,
      damageMin: 7,
      damageMax: 7,
    });

    await attack(targetId);

    const rows = await db.select().from(combatLog).where(eq(combatLog.targetId, targetId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attackerId,
      targetId,
      hit: true,
      damage: 7,
      fatal: false,
      weaponItemId: weaponId,
      payout: 0n,
    });
  });

  it("logs a miss too — every shot is a row", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 0, damageMin: 5, damageMax: 5 });

    await attack(targetId);

    const rows = await db.select().from(combatLog).where(eq(combatLog.targetId, targetId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hit: false, damage: 0, fatal: false, payout: 0n });
  });

  it("publishes player.attacked with damage 0 on a miss", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 0, damageMin: 5, damageMax: 5 });
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);

    // Rule 4: filter by our OWN actorId — game:events is global across files.
    // The promise is armed BEFORE the request, or the frame lands first.
    const received = awaitOwnEvent(subscriber, attackerId);
    await attack(targetId);
    const event = await received;

    expect(event).toMatchObject({ type: "player.attacked", targetId, damage: 0 });
  });

  it("addresses the event to attacker and victim only, never globally", async () => {
    // The position leak: a global audience broadcasts every shot to every
    // socket, so anyone watching the firehose learns who is where.
    // `awaitOwnEvent` cannot prove this — it settles on the first frame and
    // both frames carry the attacker's actorId — so collect both here.
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 3, damageMax: 3 });
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);

    const audiences = await new Promise<unknown[]>((resolve, reject) => {
      const seen: unknown[] = [];
      const onMessage = (channel: string, raw: string): void => {
        if (channel !== GAME_EVENTS_CHANNEL) return;
        const frame: unknown = JSON.parse(raw);
        // Same global-channel hazard as rule 4: ignore other files' traffic.
        if (
          typeof frame !== "object" ||
          frame === null ||
          !("actorId" in frame) ||
          frame.actorId !== attackerId ||
          !("type" in frame) ||
          frame.type !== "player.attacked"
        ) {
          return;
        }
        seen.push("audience" in frame ? frame.audience : null);
        if (seen.length === 2) {
          clearTimeout(timer);
          subscriber.off("message", onMessage);
          resolve(seen);
        }
      };
      const timer = setTimeout(() => {
        subscriber.off("message", onMessage);
        reject(new Error(`expected 2 player.attacked frames, saw ${seen.length}`));
      }, 5000);
      subscriber.on("message", onMessage);
      void attack(targetId);
    });

    expect(audiences).toHaveLength(2);
    expect(audiences).toContainEqual({ kind: "player", playerId: attackerId });
    expect(audiences).toContainEqual({ kind: "player", playerId: targetId });
  });
});

describe("GET /api/combat/log", () => {
  const readLog = () =>
    app.inject({
      method: "GET",
      url: "/api/combat/log",
      headers: { authorization: `Bearer ${attackerToken}` },
    });

  it("returns an empty log for a player who has never fought", async () => {
    const res = await readLog();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [] });
  });

  it("returns shots both taken and received, newest first", async () => {
    await makeAttackable();
    // Two rows inserted directly so ordering is deterministic without fighting
    // the cooldown — one shot per request means a route-driven pair would need
    // the cooldown key deleted between them for no gain here.
    const older = uuidv7();
    const newer = uuidv7();
    await db.insert(combatLog).values([
      {
        id: older,
        attackerId,
        targetId,
        hit: true,
        damage: 5,
        fatal: false,
        payout: 0n,
        createdAt: new Date(Date.now() - 60_000),
      },
      // Reversed: the caller is the TARGET of this one. A filter that only
      // matched `attacker_id` would drop it and this test would see one row.
      {
        id: newer,
        attackerId: targetId,
        targetId: attackerId,
        hit: false,
        damage: 0,
        fatal: false,
        payout: 0n,
        createdAt: new Date(),
      },
    ]);

    const res = await readLog();

    const { entries } = res.json();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(newer);
    expect(entries[1].id).toBe(older);
  });

  it("sends the payout as a decimal string, never a JSON number", async () => {
    // `payout` is bigint in Postgres. A JSON number reintroduces floating
    // point and silently truncates past 2^53 — the exact bug MoneySchema
    // exists to prevent, and one no other assertion in this file would catch.
    await makeAttackable();
    await db.insert(combatLog).values({
      id: uuidv7(),
      attackerId,
      targetId,
      hit: true,
      damage: 99,
      fatal: true,
      payout: 9_007_199_254_740_993n,
    });

    const { entries } = (await readLog()).json();
    expect(entries[0].payout).toBe("9007199254740993");
  });

  it("does not leak a fight between two other players", async () => {
    await makeAttackable();
    const stranger = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "Luca", password: "hunter2hunter2" },
    });
    const strangerId: string = stranger.json().playerId;
    await db.insert(combatLog).values({
      id: uuidv7(),
      attackerId: targetId,
      targetId: strangerId,
      hit: true,
      damage: 7,
      fatal: false,
      payout: 0n,
    });

    // A route that dropped its WHERE entirely would still pass every ordering
    // and cap assertion above; only this one turns red.
    expect((await readLog()).json()).toEqual({ entries: [] });
  });

  it("answers while the caller is in hospital", async () => {
    // The primary reader of this log is someone who just died and wants to
    // know who did it. The route therefore keeps the SDK's default
    // `accessInHospital: true`; the attack route sets false. A 423 here would
    // mean the gate was copied across from the action route by reflex.
    await makeAttackable();
    await db.insert(combatLog).values({
      id: uuidv7(),
      attackerId: targetId,
      targetId: attackerId,
      hit: true,
      damage: 100,
      fatal: true,
      payout: 4_000n,
    });
    await db
      .update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() + 600_000) })
      .where(eq(playerStats.playerId, attackerId));

    const res = await readLog();

    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(1);
  });

  it("caps the log at 50 entries", async () => {
    // Bounded from the start. GET /api/mail and GET /api/notifications are
    // both unbounded and unpaginated (docs/STATUS.md, open issue) — this does
    // not become the third.
    await makeAttackable();
    await db.insert(combatLog).values(
      Array.from({ length: 60 }, (_, i) => ({
        id: uuidv7(),
        attackerId,
        targetId,
        hit: true,
        damage: 1,
        fatal: false,
        payout: 0n,
        createdAt: new Date(Date.now() - i * 1000),
      })),
    );

    expect((await readLog()).json().entries).toHaveLength(50);
  });
});

describe("GET /api/combat/targets", () => {
  const targets = (token: string) =>
    app.inject({
      method: "GET",
      url: "/api/combat/targets",
      headers: { authorization: `Bearer ${token}` },
    });

  type Target = {
    playerId: string;
    username: string;
    rank: string | null;
    health: number;
    maxHealth: number;
    attackable: boolean;
    reason: string | null;
  };

  it("lists a co-located player as attackable, with reason null", async () => {
    const attacker = await register();
    const victim = await register();
    await makeAttackable(attacker.id, victim.id);

    const res = await targets(attacker.token);
    expect(res.statusCode).toBe(200);
    const list = res.json<{ targets: Target[] }>().targets;
    const row = list.find((t) => t.playerId === victim.id);
    expect(row).toMatchObject({ attackable: true, reason: null, username: victim.username });
    expect(row?.maxHealth).toBeGreaterThan(0);
  });

  it("excludes the caller's own row", async () => {
    const attacker = await register();
    const victim = await register();
    await makeAttackable(attacker.id, victim.id);

    const list = (await targets(attacker.token)).json<{ targets: Target[] }>().targets;
    expect(list.map((t) => t.playerId)).not.toContain(attacker.id);
  });

  it("excludes a player in another city", async () => {
    const attacker = await register();
    const victim = await register();
    await makeAttackable(attacker.id, victim.id);
    // A fresh, real location — location_id is FK-constrained to `locations`,
    // so an arbitrary uuid the row-lock test elsewhere relies on would fail
    // the insert rather than exercise the case.
    const elsewhere = uuidv7();
    await db.insert(locations).values({
      id: elsewhere,
      name: `far-${elsewhere.slice(-8)}`,
      travelCost: 0n,
      travelCooldownSeconds: 60,
      bulletStock: 0,
      bulletCost: 1n,
    });
    await db.update(playerStats).set({ locationId: elsewhere }).where(eq(playerStats.playerId, victim.id));

    const list = (await targets(attacker.token)).json<{ targets: Target[] }>().targets;
    expect(list.map((t) => t.playerId)).not.toContain(victim.id);
  });

  it("reports each illegal reason", async () => {
    // Module-level attacker/target plus four DIRECTLY-INSERTED strangers, not
    // six register() calls: registration is capped at 5/hour/IP
    // (`auth/routes.ts:51`) and the outer beforeEach already spends 2 of
    // those on attacker/target before this body even runs. None of the four
    // below ever authenticates, so makeStranger (a bare row insert) is both
    // sufficient and what keeps this under the cap.
    const hospitalised = await makeStranger();
    const jailed = await makeStranger();
    const mate = await makeStranger();
    const newbie = await makeStranger();
    // One call, all five ids: co-locates everyone in a SINGLE shared location.
    // Calling makeAttackable once per pair would each time mint a new
    // location and move the attacker out of the previous pair's location.
    await makeAttackable(attackerId, hospitalised.id, jailed.id, mate.id, newbie.id);

    await db
      .update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 60 * 60_000) })
      .where(eq(playerStats.playerId, hospitalised.id));
    await db
      .update(playerStats)
      .set({ jailedUntil: new Date(Date.now() + 60 * 60_000) })
      .where(eq(playerStats.playerId, jailed.id));
    const gangId = uuidv7();
    await db.insert(gangs).values({
      id: gangId,
      name: `g-${gangId.slice(-8)}`,
      bossPlayerId: attackerId,
    });
    await db
      .update(playerStats)
      .set({ gangId })
      .where(inArray(playerStats.playerId, [attackerId, mate.id]));
    await db.update(playerStats).set({ exp: 0n }).where(eq(playerStats.playerId, newbie.id));

    const list = (await targets(attackerToken)).json<{ targets: Target[] }>().targets;
    const reasonOf = (id: string) => list.find((t) => t.playerId === id)?.reason;
    expect(reasonOf(hospitalised.id)).toBe("hospitalised");
    expect(reasonOf(jailed.id)).toBe("jailed");
    expect(reasonOf(mate.id)).toBe("gang_mate");
    expect(reasonOf(newbie.id)).toBe("newbie_protected");
    expect(list.every((t) => (t.reason === null) === t.attackable)).toBe(true);
  });

  it("reports newbie_self on every row when the CALLER is under the threshold", async () => {
    const attacker = await register();
    const victim = await register();
    await makeAttackable(attacker.id, victim.id);
    await db.update(playerStats).set({ exp: 0n }).where(eq(playerStats.playerId, attacker.id));

    const list = (await targets(attacker.token)).json<{ targets: Target[] }>().targets;
    expect(list.every((t) => t.reason === "newbie_self")).toBe(true);
  });

  it("consumes no cooldown", async () => {
    const attacker = await register();
    const victim = await register();
    await makeAttackable(attacker.id, victim.id);
    await equipWeapon(attacker.id, { accuracy: 100, damageMin: 1, damageMax: 1 });

    expect((await targets(attacker.token)).statusCode).toBe(200);
    expect((await targets(attacker.token)).statusCode).toBe(200);
    // The route must not have claimed combat.attack's Redis key: a subsequent
    // attack still succeeds rather than 429ing.
    const shot = await app.inject({
      method: "POST",
      url: `/api/combat/attack/${victim.id}`,
      headers: { authorization: `Bearer ${attacker.token}` },
    });
    expect(shot.statusCode).toBe(200);
  });

  it("answers 401 without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/combat/targets" })).statusCode).toBe(401);
  });
});
