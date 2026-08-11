import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import {
  combatLog,
  gangMembers,
  gangs,
  items,
  locations,
  playerItems,
  playerStats,
  ranks,
  settings,
} from "../src/db/schema/index.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let attackerToken: string;
let attackerId: string;
let targetId: string;

/** Puts both players in the same location with enough exp to clear newbie protection. */
async function makeAttackable(): Promise<string> {
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
    .where(inArray(playerStats.playerId, [attackerId, targetId]));
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
  await db.insert(items).values({ id, name: `w-${id.slice(-8)}`, itemType, effects });
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
