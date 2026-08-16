import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, playerStats, roundEntries, rounds } from "../src/db/schema/index.js";
import { ensureCurrentRound } from "../src/game/rounds/service.js";
import { createRedis } from "../src/redis.js";
import { loadConfig } from "../src/config.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const SETTINGS = { "rounds.payout_points": "[1000,500,250]" };

afterAll(async () => { await redis.quit(); });
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

    await ensureCurrentRound(db, redis, SETTINGS);

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
    const active = await ensureCurrentRound(db, redis, SETTINGS);
    expect(active?.id).toBe(only);

    const [row] = await db.select().from(rounds).where(eq(rounds.id, only));
    const stamp = row!.snapshottedAt;
    expect(stamp).not.toBeNull();
    expect(await db.select().from(roundEntries)).toHaveLength(3);
    for (const id of [one, two, three]) {
      const [p] = await db.select().from(players).where(eq(players.id, id));
      expect(p!.roundId).toBe(only);
    }

    await ensureCurrentRound(db, redis, SETTINGS);
    const [again] = await db.select().from(rounds).where(eq(rounds.id, only));
    expect(again!.snapshottedAt?.toISOString()).toBe(stamp?.toISOString());
    expect(await db.select().from(roundEntries)).toHaveLength(3);
  });
});
