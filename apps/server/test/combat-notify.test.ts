import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { items, locations, notifications, playerItems, playerStats } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { combatLog } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let attackerToken: string;
let attackerId: string;
let targetId: string;

/** Copied from combat-kill.test.ts for the same reason it copied combat.test.ts. */
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
      // Routed (gl3-profile) boot: the newbie gate reads level, not exp.
      level: 100,
      bullets: 1000n,
      health: 100,
      gangId: null,
      jailedUntil: null,
      hospitalUntil: null,
    })
    .where(inArray(playerStats.playerId, [attackerId, targetId]));
  return locationId;
}

async function equipWeapon(effects: Record<string, unknown>): Promise<void> {
  const id = uuidv7();
  await db.insert(items).values({
    id, name: `w-${id.slice(-8)}`, itemType: "weapon",
    effects: { backfireChance: 0, ...effects },
  });
  await db.insert(playerItems).values({ playerId: attackerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: id }).where(eq(playerStats.playerId, attackerId));
}

/** Cannot miss, cannot kill a 100-health target: pure whittling. */
const peashooter = () => equipWeapon({ accuracy: 100, damageMin: 1, damageMax: 1 });
/** Cannot miss, cannot fail to kill. */
const executioner = () => equipWeapon({ accuracy: 100, damageMin: 500, damageMax: 500 });

const attack = () =>
  app.inject({
    method: "POST",
    url: `/api/combat/attack/${targetId}`,
    headers: { authorization: `Bearer ${attackerToken}` },
  });

const clearCooldown = () => redis.del(cooldownKey(attackerId, "combat.attack"));

const targetNotifications = async () =>
  db.select().from(notifications).where(eq(notifications.playerId, targetId));

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  ({ token: attackerToken, playerId: attackerId } = await registerVerifiedPlayer({ app, redis }, { username: "Rocco" }));

  const target = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Fredo", email: "fredo@example.test", password: "hunter2hunter2" },
  });
  ({ playerId: targetId } = target.json());
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("combat notifications", () => {
  it("notifies the target on the first attack, pointing at the combat log", async () => {
    await makeAttackable();
    await peashooter();

    const res = await attack();
    expect(res.statusCode).toBe(200);

    const rows = await targetNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain("Rocco");
    expect(rows[0].body).toContain("combat log");
  });

  it("does not notify again for follow-up shots in the same engagement", async () => {
    await makeAttackable();
    await peashooter();

    expect((await attack()).statusCode).toBe(200);
    await clearCooldown();
    expect((await attack()).statusCode).toBe(200);

    expect(await targetNotifications()).toHaveLength(1);
  });

  it("notifies again once the engagement window has lapsed", async () => {
    await makeAttackable();
    await peashooter();
    expect((await attack()).statusCode).toBe(200);

    // Backdate the only log row past the window rather than sleeping through it.
    await db
      .update(combatLog)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(and(eq(combatLog.attackerId, attackerId), eq(combatLog.targetId, targetId)));
    await clearCooldown();
    expect((await attack()).statusCode).toBe(200);

    expect(await targetNotifications()).toHaveLength(2);
  });

  it("a one-shot kill sends the death alert alone, never a second attack alert", async () => {
    await makeAttackable();
    await executioner();

    const res = await attack();
    expect(res.statusCode).toBe(200);
    expect(res.json().targetKilled).toBe(true);

    const rows = await targetNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain("killed");
    expect(rows[0].body).toContain("Rocco");
    expect(rows[0].body).toContain("combat log");
  });

  it("a whittling kill leaves the attack alert plus the death alert", async () => {
    await makeAttackable();
    await peashooter();
    expect((await attack()).statusCode).toBe(200);

    await executioner();
    await clearCooldown();
    const res = await attack();
    expect(res.statusCode).toBe(200);
    expect(res.json().targetKilled).toBe(true);

    const rows = await targetNotifications();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.body.includes("killed"))).toHaveLength(1);
  });

  it("a first shot that backfires still alerts the target", async () => {
    // The log row is written on a backfire ("who shot at me", and someone
    // did); the alert carries exactly the same fact, no more — the jam stays
    // the attacker's secret.
    await makeAttackable();
    await equipWeapon({ accuracy: 100, damageMin: 1, damageMax: 1, backfireChance: 100 });

    const res = await attack();
    expect(res.statusCode).toBe(200);
    expect(res.json().backfire).toBe(true);

    const rows = await targetNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain("Rocco");
    expect(rows[0].body).not.toContain("backfire");
  });
});
