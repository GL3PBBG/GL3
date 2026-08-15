import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import {
  items,
  locations,
  playerItems,
  playerStats,
  settings,
  transactions,
} from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { combatLog } from "./helpers/plugin-tables.js";
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

/**
 * Copied from `combat.test.ts` rather than shared. Two files is not enough to
 * justify a helper module, and the copy is what lets this file diverge — it
 * cares about cash and hospital deadlines, which the legality file does not.
 */
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

/** Seeds an item and equips it as `weapon_item_id`. Returns the item id. */
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

/**
 * A weapon that cannot fail to kill: accuracy 100 puts the hit roll beyond
 * doubt and 500 damage is past any rank's maxHealth, so every test below
 * starts from a certain death rather than a lucky one.
 */
const executioner = (): Promise<string> =>
  equipWeapon(attackerId, { accuracy: 100, damageMin: 500, damageMax: 500 });

const attack = (id: string) =>
  app.inject({
    method: "POST",
    url: `/api/combat/attack/${id}`,
    headers: { authorization: `Bearer ${attackerToken}` },
  });

const statsOf = async (playerId: string) => {
  const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
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
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("POST /api/combat/attack/:targetId — death", () => {
  it("kills, takes all on-hand cash, spares the bank, and hospitalises", async () => {
    await makeAttackable();
    await executioner();
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, attackerId));
    await db
      .update(playerStats)
      .set({ cash: 250_000n, bank: 900_000n, health: 100 })
      .where(eq(playerStats.playerId, targetId));

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hit: true,
      targetKilled: true,
      targetHealth: 0,
      payout: "250000",
    });

    const victim = await statsOf(targetId);
    expect(victim?.cash).toBe(0n);
    // The bank is the whole counterplay: if this ever reads 0 the game has no
    // answer to being hunted other than not playing.
    expect(victim?.bank).toBe(900_000n);
    expect(victim?.health).toBe(0);
    expect(victim?.hospitalUntil).not.toBeNull();

    expect((await statsOf(attackerId))?.cash).toBe(250_000n);
  });

  it("ledgers both sides of the transfer", async () => {
    // CLAUDE.md rule 3, restricted to the movement under test: every cash
    // change is one applyBalanceChange and one ledger row. A transfer that
    // moved cash with a bare UPDATE, or ledgered only the killer's side, would
    // pass every assertion in the test above and break this one.
    //
    // The assertion is on the DELTA, not on `sum(ledger) == balance`. The
    // seeding below sets cash with a raw UPDATE and so writes no ledger row —
    // this file deliberately starts the victim off-ledger because there is no
    // route that hands a player cash. `resetDb` truncates `transactions`, so
    // every row present afterwards belongs to the attack.
    await makeAttackable();
    await executioner();
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, attackerId));
    await db.update(playerStats).set({ cash: 120_000n }).where(eq(playerStats.playerId, targetId));
    const before = new Map([
      [attackerId, 0n],
      [targetId, 120_000n],
    ]);

    await attack(targetId);

    for (const id of [attackerId, targetId]) {
      const rows = await db.select().from(transactions).where(eq(transactions.playerId, id));
      const cashRows = rows.filter((t) => t.balanceKind === "cash");
      expect(cashRows).toHaveLength(1);
      const cashSum = cashRows.reduce((acc, t) => acc + t.amount, 0n);
      expect(cashSum).toBe(((await statsOf(id))?.cash ?? 0n) - (before.get(id) ?? 0n));
    }

    // Zero-sum: the money moved, none was minted or burned.
    const all = await db.select().from(transactions);
    const combatRows = all.filter((t) => t.reason.startsWith("combat."));
    expect(combatRows.reduce((acc, t) => acc + t.amount, 0n)).toBe(0n);
    expect(combatRows.map((t) => t.reason).sort()).toEqual([
      "combat.kill_payout",
      "combat.killed",
    ]);
  });

  it("writes a fatal log row carrying the payout", async () => {
    await makeAttackable();
    await executioner();
    await db.update(playerStats).set({ cash: 5_000n }).where(eq(playerStats.playerId, targetId));

    await attack(targetId);

    const rows = await db.select().from(combatLog).where(eq(combatLog.targetId, targetId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fatal: true, payout: 5_000n });
  });

  it("publishes player.killed after player.attacked, to both parties", async () => {
    // Ordering is the point, and `awaitOwnEvent` cannot see it: it settles on
    // the FIRST frame carrying this actorId, which is always player.attacked.
    // Collect all four frames (two events × two audiences) instead.
    //
    // A client rendering "shot for 500" then "killed" reads correctly; the
    // reverse reads as a corpse taking damage.
    await makeAttackable();
    await executioner();
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);

    const frames = await new Promise<{ type: unknown; audience: unknown }[]>((resolve, reject) => {
      const seen: { type: unknown; audience: unknown }[] = [];
      const onMessage = (channel: string, raw: string): void => {
        if (channel !== GAME_EVENTS_CHANNEL) return;
        const frame: unknown = JSON.parse(raw);
        // Rule 4: the channel is global across every test file, so filter to
        // this test's own actor before believing anything.
        if (
          typeof frame !== "object" ||
          frame === null ||
          !("actorId" in frame) ||
          frame.actorId !== attackerId
        ) {
          return;
        }
        seen.push({
          type: "type" in frame ? frame.type : null,
          audience: "audience" in frame ? frame.audience : null,
        });
        if (seen.length === 4) {
          clearTimeout(timer);
          subscriber.off("message", onMessage);
          resolve(seen);
        }
      };
      const timer = setTimeout(() => {
        subscriber.off("message", onMessage);
        reject(new Error(`expected 4 frames, saw ${seen.length}: ${JSON.stringify(seen)}`));
      }, 5000);
      subscriber.on("message", onMessage);
      void attack(targetId);
    });

    expect(frames.map((f) => f.type)).toEqual([
      "player.attacked",
      "player.attacked",
      "player.killed",
      "player.killed",
    ]);
    const killAudiences = frames.filter((f) => f.type === "player.killed").map((f) => f.audience);
    expect(killAudiences).toContainEqual({ kind: "player", playerId: attackerId });
    expect(killAudiences).toContainEqual({ kind: "player", playerId: targetId });
  });

  it("names the victim in player.killed", async () => {
    // victimName is a required field of the event (`shared/src/events.ts`) and
    // a client has no other way to render "you killed X" without a lookup.
    await makeAttackable();
    await executioner();
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);

    const killed = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMessage = (channel: string, raw: string): void => {
        if (channel !== GAME_EVENTS_CHANNEL) return;
        const frame: unknown = JSON.parse(raw);
        if (
          typeof frame !== "object" ||
          frame === null ||
          !("actorId" in frame) ||
          frame.actorId !== attackerId ||
          !("type" in frame) ||
          frame.type !== "player.killed"
        ) {
          return;
        }
        clearTimeout(timer);
        subscriber.off("message", onMessage);
        resolve({ ...frame });
      };
      const timer = setTimeout(() => {
        subscriber.off("message", onMessage);
        reject(new Error("no player.killed frame"));
      }, 5000);
      subscriber.on("message", onMessage);
      void attack(targetId);
    });

    expect(killed).toMatchObject({ victimId: targetId, victimName: "Fredo", actorName: "Rocco" });
  });

  it("kills a victim with no cash without writing a spurious ledger row", async () => {
    // `applyBalanceChange` with 0n may be a no-op or may write a zero row; the
    // route skips both calls rather than depending on which.
    await makeAttackable();
    await executioner();
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, targetId));

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ targetKilled: true, payout: "0" });
    const rows = await db.select().from(transactions).where(eq(transactions.playerId, targetId));
    expect(rows.filter((t) => t.reason === "combat.killed")).toHaveLength(0);
  });

  it("leaves the victim's cash alone on a hit that does not kill", async () => {
    // The transfer is gated on death, not on landing a hit. Without the gate
    // every graze would empty a wallet, which no assertion above would catch:
    // they all kill.
    await makeAttackable();
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 10, damageMax: 10 });
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, attackerId));
    await db.update(playerStats).set({ cash: 77_000n }).where(eq(playerStats.playerId, targetId));

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ targetKilled: false, payout: "0" });
    expect((await statsOf(targetId))?.cash).toBe(77_000n);
    expect((await statsOf(attackerId))?.cash).toBe(0n);
    expect((await statsOf(targetId))?.hospitalUntil).toBeNull();
  });

  it("blocks a follow-up attack on the now-hospitalised victim", async () => {
    // Corpse-camping. The hospital deadline is the only thing standing between
    // a dead player and being farmed the moment the cooldown lapses.
    await makeAttackable();
    await executioner();

    await attack(targetId);
    // Targeted DEL of this attacker's own key — never FLUSHDB. `attackerId` is
    // a fresh uuidv7 per test, so no other file or agent owns this key.
    await redis.del(cooldownKey(attackerId, "combat.attack"));

    const second = await attack(targetId);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "target_hospitalised" });
  });

  it("takes the hospital sentence length from the settings table", async () => {
    // `combat.hospital_seconds` is declared and defaulted, and nothing else
    // proves it is READ — the same shape as the double-prefix bug, where every
    // setting silently fell back to its default with no error anywhere. 4242
    // is far enough from the 600 default that a fallback cannot mimic it.
    await makeAttackable();
    await executioner();
    await db.insert(settings).values({ key: "combat.hospital_seconds", value: "4242" });

    // Settings are snapshotted at boot, so the row must predate the server.
    const { app: freshApp, close } = await bootTestServer();
    try {
      const before = Date.now();
      const res = await freshApp.inject({
        method: "POST",
        url: `/api/combat/attack/${targetId}`,
        headers: { authorization: `Bearer ${attackerToken}` },
      });
      expect(res.statusCode).toBe(200);

      const until = (await statsOf(targetId))?.hospitalUntil?.getTime() ?? 0;
      expect(until).toBeGreaterThanOrEqual(before + 4242 * 1000);
      expect(until).toBeLessThan(before + (4242 + 60) * 1000);
    } finally {
      await close();
    }
  });
});
