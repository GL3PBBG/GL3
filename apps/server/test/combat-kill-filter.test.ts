import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, on } from "@gl3/plugin-sdk";
import { killResolved, type KillResolved } from "@gl3/plugin-combat";
import {
  items,
  locations,
  playerItems,
  playerStats,
} from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { loadConfig } from "../src/config.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
const subscriber = createSubscriber(redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let attackerToken: string;
let attackerId: string;
let targetId: string;

const seen: KillResolved[] = [];
let explode = false;

const spyPlugin = definePlugin({
  id: "kill-filter-spy",
  version: "1.0.0",
  basePaths: ["/api/kill-filter-spy"],
  filters: [
    on(killResolved, (ctx, value) => {
      seen.push(value);
      if (explode) throw new Error("subscriber exploded");
      return value;
    }),
  ],
});

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

async function equipWeapon(playerId: string, effects: Record<string, unknown>): Promise<string> {
  const id = uuidv7();
  // Spread first so a caller can override. See combat.test.ts's equipWeapon
  // for why: the default `combat.backfire.base_chance` of 2 otherwise gives
  // every shot a 2% chance of returning early with no kill and no ledger row.
  await db.insert(items).values({
    id, name: `w-${id.slice(-8)}`, itemType: "weapon",
    effects: { backfireChance: 0, ...effects },
  });
  await db.insert(playerItems).values({ playerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: id }).where(eq(playerStats.playerId, playerId));
  return id;
}

const executioner = (): Promise<string> =>
  equipWeapon(attackerId, { accuracy: 100, damageMin: 500, damageMax: 500 });

const attack = (id: string) =>
  app.inject({
    method: "POST",
    url: `/api/combat/attack/${id}`,
    headers: { authorization: `Bearer ${attackerToken}` },
  });

beforeEach(async () => {
  seen.length = 0;
  explode = false;
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer({ plugins: [spyPlugin] }));

  const attacker = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Rocco", password: "hunter2hunter2" },
  });
  ({ token: attackerToken, playerId: attackerId } = attacker.json());

  const target = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Fredo", password: "hunter2hunter2" },
  });
  ({ playerId: targetId } = target.json());
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("combat.killResolved filter point", () => {
  it("fires once per kill with killer and victim ids, and not on a non-kill", async () => {
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 1, damageMax: 1 });
    await attack(targetId); // survivable — no fire
    expect(seen).toHaveLength(0);

    await redis.del(cooldownKey(attackerId, "combat.attack"));
    await executioner();
    const res = await attack(targetId);
    expect(res.json().targetKilled).toBe(true);
    expect(seen).toEqual([{ killerId: attackerId, victimId: targetId }]);
  });

  it("a throwing subscriber does not turn the kill into a 500", async () => {
    await makeAttackable();
    await executioner();
    explode = true;
    const res = await attack(targetId);
    expect(res.statusCode).toBe(200);
    expect(res.json().targetKilled).toBe(true);
  });
});
