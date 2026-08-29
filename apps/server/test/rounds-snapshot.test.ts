import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { players, playerStats, roleModuleAccess, roundEntries, rounds } from "../src/db/schema/index.js";
import { ensureCurrentRound } from "../src/game/rounds/service.js";
import { roundStandings } from "../src/game/rounds/standings.js";
import { createRedis } from "../src/redis.js";
import { loadConfig } from "../src/config.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";
import { createOutboxDelivery } from "../src/bus/outbox.js";

const { db } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const SETTINGS = { "rounds.payout_points": "[1000,500,250]" };

let app: Awaited<ReturnType<typeof bootTestServer>>["app"];
let closeServer: () => Promise<void>;
beforeAll(async () => { const booted = await bootTestServer(); app = booted.app; closeServer = booted.close; });
afterAll(async () => { await closeServer(); await redis.quit(); });
beforeEach(async () => { await resetDb(db); });

async function seedPlayer(username: string, exp: bigint): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id, exp });
  return id;
}

async function seedRound(
  name: string, startsAt: Date | null, endsAt: Date | null,
  stamps?: { snapshottedAt?: Date },
): Promise<string> {
  const id = uuidv7();
  await db.insert(rounds).values({ id, name, startsAt, endsAt, snapshottedAt: stamps?.snapshottedAt ?? null });
  return id;
}

const ago = (ms: number): Date => new Date(Date.now() - ms);
const ahead = (ms: number): Date => new Date(Date.now() + ms);

describe("round activation snapshot", () => {
  it("gives every player an entry at their own values, including players who never made a request", async () => {
    const passiveA = await seedPlayer("passive_a", 10n);
    const passiveB = await seedPlayer("passive_b", 20n);
    const passiveC = await seedPlayer("passive_c", 30n);
    await db.update(playerStats).set({ cash: 111n, bank: 222n }).where(eq(playerStats.playerId, passiveA));

    const ended = await seedRound("Prev", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const next = await seedRound("Next", ago(60_000), ahead(3_600_000));

    await ensureCurrentRound(db, createOutboxDelivery(db, { redis }), SETTINGS);

    const entries = await db.select().from(roundEntries).where(eq(roundEntries.roundId, next));
    expect(entries).toHaveLength(3);
    const a = entries.find((e) => e.playerId === passiveA)!;
    expect([a.expAtStart, a.cashAtStart, a.bankAtStart]).toEqual([10n, 111n, 222n]);
    for (const id of [passiveA, passiveB, passiveC]) {
      const [row] = await db.select().from(players).where(eq(players.id, id));
      expect(row!.roundId).toBe(next);
    }
    // The same call finalized the predecessor before activating `next` — the
    // settle loop's finalize-before-activate ordering, exercised here rather
    // than merely asserted by construction.
    const [prevRow] = await db.select().from(rounds).where(eq(rounds.id, ended));
    expect(prevRow!.finalizedAt).not.toBeNull();
  });

  it("activates the very first round with no predecessor, exactly once", async () => {
    const one = await seedPlayer("first_a", 1n);
    const two = await seedPlayer("first_b", 2n);
    const three = await seedPlayer("first_c", 3n);
    expect(await db.select().from(roundEntries)).toEqual([]);

    const only = await seedRound("Round One", ago(60_000), ahead(3_600_000));
    const active = await ensureCurrentRound(db, createOutboxDelivery(db, { redis }), SETTINGS);
    expect(active?.id).toBe(only);

    const [row] = await db.select().from(rounds).where(eq(rounds.id, only));
    const stamp = row!.snapshottedAt;
    expect(stamp).not.toBeNull();
    expect(await db.select().from(roundEntries)).toHaveLength(3);
    for (const id of [one, two, three]) {
      const [p] = await db.select().from(players).where(eq(players.id, id));
      expect(p!.roundId).toBe(only);
    }

    await ensureCurrentRound(db, createOutboxDelivery(db, { redis }), SETTINGS);
    const [again] = await db.select().from(rounds).where(eq(rounds.id, only));
    expect(again!.snapshottedAt?.toISOString()).toBe(stamp?.toISOString());
    expect(await db.select().from(roundEntries)).toHaveLength(3);
  });
});

describe("registration snapshot", () => {
  it("gives a mid-round registrant an entry at their own values, standing 0", async () => {
    const roundId = await seedRound("Mid", ago(60_000), ahead(3_600_000), { snapshottedAt: ago(60_000) });

    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "midjoiner", email: "midjoiner@example.test", password: "correct horse battery" },
    });
    expect(res.statusCode).toBe(201);

    const [player] = await db.select().from(players).where(eq(players.username, "midjoiner"));

    const [entry] = await db.select().from(roundEntries)
      .where(and(eq(roundEntries.roundId, roundId), eq(roundEntries.playerId, player!.id)));
    expect(entry).toBeDefined();
    expect(entry!.expAtStart).toBe(0n);
    expect(entry!.cashAtStart).toBe(0n);
    expect(entry!.joinedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(entry!.joinedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(player!.roundId).toBe(roundId);

    // Standing is 0 the instant they join — this is the whole point of a
    // per-player snapshot, and it's the one assertion a bug that read raw
    // `exp` instead of the delta could still pass, since a fresh player's
    // absolute exp is also 0. Checked BEFORE any stats mutation below.
    const freshBoard = await roundStandings(db, roundId, "exp", 10, false);
    const freshMine = freshBoard.find((e) => e.playerId === player!.id);
    expect(freshMine!.score).toBe("0");

    await db.update(playerStats).set({ exp: 500n, cash: 700n }).where(eq(playerStats.playerId, player!.id));

    const board = await roundStandings(db, roundId, "exp", 10, false);
    const mine = board.find((e) => e.playerId === player!.id);
    expect(mine!.score).toBe("500");   // delta from THEIR start, not their absolute total
  });

  it("writes no entry and leaves round_id null when no round is active", async () => {
    expect(await db.select().from(rounds)).toEqual([]);
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "noroundplayer", email: "noroundplayer@example.test", password: "correct horse battery" },
    });
    expect(res.statusCode).toBe(201);

    const [player] = await db.select().from(players).where(eq(players.username, "noroundplayer"));
    expect(player!.roundId).toBeNull();
    expect(await db.select().from(roundEntries)).toEqual([]);
  });

  it("writes no entry when the current round has ended but nobody has rolled it over", async () => {
    await seedRound("Over", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "afterhours", email: "afterhours@example.test", password: "correct horse battery" },
    });
    expect(res.statusCode).toBe(201);
    const [player] = await db.select().from(players).where(eq(players.username, "afterhours"));
    expect(player!.roundId).toBeNull();
    expect(await db.select().from(roundEntries)).toEqual([]);
  });

  it("still makes the first registration an Administrator while a round is active", async () => {
    await seedRound("Admin Round", ago(60_000), ahead(3_600_000), { snapshottedAt: ago(60_000) });
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "firstadmin", email: "firstadmin@example.test", password: "correct horse battery" },
    });
    expect(res.statusCode).toBe(201);

    const [player] = await db.select().from(players).where(eq(players.username, "firstadmin"));
    expect(player!.roleId).not.toBeNull();
    const grants = await db.select().from(roleModuleAccess).where(eq(roleModuleAccess.roleId, player!.roleId!));
    expect(grants.map((g) => g.moduleKey)).toContain("*");
    expect(await db.select().from(roundEntries)).toHaveLength(1);
  });
});
