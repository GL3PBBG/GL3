import { eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import {
  bounties,
  items,
  locations,
  notifications,
  playerItems,
  playerStats,
  transactions,
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
let backerId: string;
let backer2Id: string;

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

async function equipWeapon(
  playerId: string,
  effects: Record<string, unknown>,
): Promise<string> {
  const id = uuidv7();
  await db
    .insert(items)
    .values({ id, name: `w-${id.slice(-8)}`, itemType: "weapon", effects });
  await db
    .insert(playerItems)
    .values({ playerId, itemId: id, qty: 1 });
  await db
    .update(playerStats)
    .set({ weaponItemId: id })
    .where(eq(playerStats.playerId, playerId));
  return id;
}

const executioner = (): Promise<string> =>
  equipWeapon(attackerId, {
    accuracy: 100,
    damageMin: 500,
    damageMax: 500,
  });

const attack = (id: string) =>
  app.inject({
    method: "POST",
    url: `/api/combat/attack/${id}`,
    headers: { authorization: `Bearer ${attackerToken}` },
  });

const statsOf = async (playerId: string) => {
  const [row] = await db
    .select()
    .from(playerStats)
    .where(eq(playerStats.playerId, playerId));
  return row;
};

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

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

  const backer = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Backer", password: "hunter2hunter2" },
  });
  ({ playerId: backerId } = backer.json());

  const backer2 = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Backer2", password: "hunter2hunter2" },
  });
  ({ playerId: backer2Id } = backer2.json());
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("bounty claim on kill", () => {
  it("kill sweeps all open bounties on the victim to the killer", async () => {
    await makeAttackable();
    await executioner();
    await db
      .update(playerStats)
      .set({ cash: 0n })
      .where(inArray(playerStats.playerId, [attackerId, targetId]));
    await db.insert(bounties).values([
      { id: uuidv7(), placedBy: backerId, target: targetId, amount: 3000n },
      { id: uuidv7(), placedBy: backer2Id, target: targetId, amount: 2000n },
    ]);

    const res = await attack(targetId);
    expect(res.json().targetKilled).toBe(true);

    const open = await db
      .select()
      .from(bounties)
      .where(isNull(bounties.claimedBy));
    expect(open).toHaveLength(0);
    const killer = await statsOf(attackerId);
    expect(killer?.cash).toBe(5000n); // victim had 0; all cash is bounty money
    const claimLedger = await db
      .select()
      .from(transactions)
      .where(eq(transactions.reason, "bounties.claimed"));
    expect(claimLedger).toHaveLength(1);
    expect(claimLedger[0].amount).toBe(5000n);
  });

  it("a kill with no open bounty writes nothing", async () => {
    await makeAttackable();
    await executioner();
    const res = await attack(targetId);
    expect(res.json().targetKilled).toBe(true);
    expect(
      await db
        .select()
        .from(transactions)
        .where(eq(transactions.reason, "bounties.claimed")),
    ).toHaveLength(0);
  });

  it("a claimed bounty is not re-claimed when the target dies again", async () => {
    await makeAttackable();
    await executioner();
    await db.insert(bounties).values([
      { id: uuidv7(), placedBy: backerId, target: targetId, amount: 3000n },
    ]);
    await attack(targetId); // first kill claims it

    // discharge: clear hospital sentence and restore health
    await db
      .update(playerStats)
      .set({ hospitalUntil: null, health: 100 })
      .where(eq(playerStats.playerId, targetId));
    await redis.del(cooldownKey(attackerId, "combat.attack"));
    await attack(targetId); // second kill

    const claimLedger = await db
      .select()
      .from(transactions)
      .where(eq(transactions.reason, "bounties.claimed"));
    expect(claimLedger).toHaveLength(1); // still exactly one
  });

  it("notifies the placer and emits bounty.claimed to killer and placer", async () => {
    await makeAttackable();
    await executioner();
    const bountyId = uuidv7();
    await db.insert(bounties).values([
      { id: bountyId, placedBy: backerId, target: targetId, amount: 3000n },
    ]);
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);

    // Collect ALL events for the killer (actorId = attackerId), then filter
    // for bounty.claimed — player.attacked / player.killed arrive first.
    const bountyEvents = await new Promise<
      { type: string; audience: unknown; bountyId: string; amount: string; targetId: string }[]
    >((resolve, reject) => {
      const collected: {
        type: string;
        audience: unknown;
        bountyId: string;
        amount: string;
        targetId: string;
      }[] = [];
      const onMessage = (channel: string, raw: string): void => {
        if (channel !== GAME_EVENTS_CHANNEL) return;
        const frame: Record<string, unknown> = JSON.parse(raw);
        // Rule 4: filter by own actorId
        if (frame.actorId !== attackerId) return;
        if (frame.type === "bounty.claimed") {
          collected.push({
            type: String(frame.type),
            audience: frame.audience,
            bountyId: String(frame.bountyId),
            amount: String(frame.amount),
            targetId: String(frame.targetId),
          });
        }
        // Expect 2 bounty.claimed events (killer + placer)
        if (collected.length === 2) {
          clearTimeout(timer);
          subscriber.off("message", onMessage);
          resolve(collected);
        }
      };
      const timer = setTimeout(() => {
        subscriber.off("message", onMessage);
        reject(
          new Error(
            `expected 2 bounty.claimed events, saw ${collected.length}`,
          ),
        );
      }, 5000);
      subscriber.on("message", onMessage);
      void attack(targetId);
    });

    // Two bounty.claimed events: one to killer, one to placer
    expect(bountyEvents).toHaveLength(2);
    const audiences = bountyEvents.map((e) => e.audience);
    expect(audiences).toContainEqual({
      kind: "player",
      playerId: attackerId,
    });
    expect(audiences).toContainEqual({
      kind: "player",
      playerId: backerId,
    });
    for (const event of bountyEvents) {
      expect(event.amount).toBe("3000");
      expect(event.targetId).toBe(targetId);
    }

    // Placer received a notification
    const [note] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.playerId, backerId));
    expect(note.body).toContain("bounty");
  });
});
