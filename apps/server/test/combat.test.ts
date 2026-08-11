import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  gangMembers,
  gangs,
  items,
  locations,
  playerItems,
  playerStats,
  ranks,
} from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
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
});

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

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, targetId));
    expect(row?.hospitalUntil).toBeNull();
    expect(row?.health).toBe(150);
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
