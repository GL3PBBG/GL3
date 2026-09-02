import { AttackResponseSchema } from "@gl3/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { items, locations, playerItems, playerStats, settings } from "../src/db/schema/index.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { combatLog, weaponCondition } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Split out of `combat.test.ts` (legality/resolution) because every test here
 * needs its own `combat.backfire.*`/`combat.condition.*` settings row — and
 * settings are read into a snapshot at server boot (see `combat.test.ts`'s
 * own comment on that), so this file reboots the server on every
 * `setSetting` call rather than once in `beforeEach`. That is also why
 * `beforeEach` below always closes and rebuilds `app`, unlike the sibling
 * combat files that boot once and reuse it: reusing a rebooted app across
 * tests would leak one test's settings snapshot into the next, even though
 * `resetDb` truncates the underlying rows.
 */
const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
// Named `redis` (not `subscriber`) to match this file's own event test below.
const redis = createSubscriber(redisUrl);
// A SEPARATE, ordinary client for registerVerifiedPlayer's Redis reads —
// `redis` above enters Redis's dedicated subscriber mode the moment any test
// calls `redis.subscribe(...)`, after which no other command (GET, KEYS, ...)
// can run on that same connection for the rest of this file's run.
const cmdRedis = createRedis(redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let attacker: string;
let target: string;
let weaponId: string;

/** player_stats.cash on registration — the column default, untouched here. */
const TARGET_START_CASH = 0n;

async function makeAttackable(): Promise<void> {
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
    .where(inArray(playerStats.playerId, [attacker, target]));
}

/** Seeds an item and equips it as `weapon_item_id`. Returns the item id. */
async function equipWeapon(playerId: string, effects: Record<string, unknown>): Promise<string> {
  const id = uuidv7();
  await db.insert(items).values({ id, name: `w-${id.slice(-8)}`, itemType: "weapon", effects });
  await db.insert(playerItems).values({ playerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: id }).where(eq(playerStats.playerId, playerId));
  return id;
}

const attack = (bearerToken: string, id: string) =>
  app.inject({
    method: "POST",
    url: `/api/combat/attack/${id}`,
    headers: { authorization: `Bearer ${bearerToken}` },
  });

const statsOf = async (playerId: string) => {
  const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
  return row;
};

/**
 * Inserts one settings row and reboots the server so `ctx.settings.get` sees
 * it — a plain `db.insert` is invisible to an already-running app (settings
 * are a snapshot taken once at boot, see `combat.test.ts`). Rebooting on
 * every call — rather than batching — keeps each `await setSetting(...)`
 * line in the tests below honest: the setting it names is guaranteed live by
 * the time the call returns.
 */
async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settings).values({ key, value });
  await closeServer();
  ({ app, close: closeServer } = await bootTestServer());
}

beforeEach(async () => {
  await resetDb(db);
  if (app) await closeServer();
  ({ app, close: closeServer } = await bootTestServer());

  ({ token, playerId: attacker } = await registerVerifiedPlayer({ app, redis: cmdRedis }, { username: "Nico" }));

  // Never authenticates as the target below, just needs a real player row.
  const targetRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Gio", email: "gio@example.test", password: "hunter2hunter2" },
  });
  ({ playerId: target } = targetRes.json());

  await makeAttackable();
  // Fixed damage: selfDamage on a backfire is drawn from this same range, so
  // pinning it makes every assertion below on exact health/condition numbers
  // deterministic rather than a flaky range check.
  weaponId = await equipWeapon(attacker, { accuracy: 100, damageMin: 10, damageMax: 10 });
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
  cmdRedis.disconnect();
});

describe("POST /api/combat/attack/:targetId — backfire and weapon condition", () => {
  it("increments the lifetime counter, damages the attacker, and leaves the target alone", async () => {
    await setSetting("combat.backfire.base_chance", "100");
    const before = await statsOf(attacker);

    const res = await attack(token, target);

    expect(res.statusCode).toBe(200);
    const body = AttackResponseSchema.parse(res.json());
    expect(body.backfire).toBe(true);
    expect(body.hit).toBe(false);
    expect(body.damage).toBe(0);
    expect(body.selfDamage).toBeGreaterThan(0);
    expect(body.targetKilled).toBe(false);

    const after = await statsOf(attacker);
    expect(after.backfire).toBe(before.backfire + 1);
    expect(after.health).toBe(Math.max(0, before.health - body.selfDamage));
    expect(after.bullets).toBeLessThan(before.bullets);

    const targetAfter = await statsOf(target);
    expect(targetAfter.health).toBe(100);
    expect(targetAfter.cash).toBe(TARGET_START_CASH);
  });

  it("writes a miss-shaped combat log row", async () => {
    await setSetting("combat.backfire.base_chance", "100");
    await attack(token, target);

    const [logRow] = await db.select().from(combatLog)
      .where(eq(combatLog.attackerId, attacker))
      .orderBy(desc(combatLog.createdAt)).limit(1);
    expect(logRow?.hit).toBe(false);
    expect(logRow?.damage).toBe(0);
    expect(logRow?.fatal).toBe(false);
    expect(logRow?.payout).toBe(0n);
  });

  it("hospitalises the ATTACKER when the self-damage reaches zero health", async () => {
    await setSetting("combat.backfire.base_chance", "100");
    await db.update(playerStats).set({ health: 1 }).where(eq(playerStats.playerId, attacker));

    const body = AttackResponseSchema.parse((await attack(token, target)).json());
    expect(body.attackerHealth).toBe(0);

    const after = await statsOf(attacker);
    expect(after.hospitalUntil).not.toBeNull();
  });

  it("publishes player.backfired to the attacker only", async () => {
    await setSetting("combat.backfire.base_chance", "100");
    await redis.subscribe(GAME_EVENTS_CHANNEL);
    const seen = awaitOwnEvent(redis, attacker);
    await attack(token, target);
    const event = await seen;
    expect(event.type).toBe("player.backfired");
    expect(event.audience).toEqual({ kind: "player", playerId: attacker });
  });

  it("wears the weapon on a normal shot and creates the row on the first one", async () => {
    await setSetting("combat.backfire.base_chance", "0");
    await setSetting("combat.condition.wear_per_shot", "5");

    await attack(token, target);
    const [row] = await db.select().from(weaponCondition)
      .where(and(eq(weaponCondition.playerId, attacker), eq(weaponCondition.itemId, weaponId)));
    expect(row?.condition).toBe(95);
  });

  it("ages a planted row forward before wearing it", async () => {
    await setSetting("combat.backfire.base_chance", "0");
    await setSetting("combat.condition.wear_per_shot", "1");
    await setSetting("combat.condition.decay_period_seconds", "86400");
    await setSetting("combat.condition.decay_per_period", "10");
    await db.insert(weaponCondition).values({
      playerId: attacker, itemId: weaponId, condition: 100,
      updatedAt: new Date(Date.now() - 3 * 86_400_000),
    });

    await attack(token, target);
    const [row] = await db.select().from(weaponCondition)
      .where(and(eq(weaponCondition.playerId, attacker), eq(weaponCondition.itemId, weaponId)));
    // 100 - (3 periods x 10) = 70, then - 1 wear = 69.
    expect(row?.condition).toBe(69);
  });

  it("does not wear or backfire on an unarmed attack", async () => {
    await setSetting("combat.backfire.base_chance", "100");
    await db.update(playerStats).set({ weaponItemId: null }).where(eq(playerStats.playerId, attacker));

    const body = AttackResponseSchema.parse((await attack(token, target)).json());
    expect(body.backfire).toBe(false);

    const rows = await db.select().from(weaponCondition).where(eq(weaponCondition.playerId, attacker));
    expect(rows).toHaveLength(0);
  });
});
