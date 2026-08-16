import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { notifications, players, playerStats, roundEntries, rounds, transactions }
  from "../src/db/schema/index.js";
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

describe("ensureCurrentRound finalize", () => {
  it("settles exactly once across three sequential calls", async () => {
    const ended = await seedRound("Ended", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const next = await seedRound("Next", ago(60_000), ahead(3_600_000));
    const a = await seedPlayer("fin_a", 500n);
    const b = await seedPlayer("fin_b", 300n);
    const c = await seedPlayer("fin_c", 100n);
    const d = await seedPlayer("fin_d", 0n);
    for (const [id, exp] of [[a, 0n], [b, 0n], [c, 0n], [d, 0n]] as const) {
      await db.insert(roundEntries).values({ roundId: ended, playerId: id, expAtStart: exp });
    }

    const active = await ensureCurrentRound(db, redis, SETTINGS);
    expect(active?.id).toBe(next);

    const [settled] = await db.select().from(rounds).where(eq(rounds.id, ended));
    const stamp = settled!.finalizedAt;
    expect(stamp).not.toBeNull();

    const frozen = await db.select().from(roundEntries).where(eq(roundEntries.roundId, ended));
    const frozenExp = new Map(frozen.map((r) => [r.playerId, r.finalExp]));
    expect(frozenExp.get(a)).toBe(500n);

    const payouts = () => db.select().from(transactions)
      .where(and(eq(transactions.reason, "round.payout"), eq(transactions.refId, ended)));
    expect(await payouts()).toHaveLength(3);

    // Move the live numbers so a re-freeze would be visible.
    await db.update(playerStats).set({ exp: 99_999n }).where(eq(playerStats.playerId, a));

    await ensureCurrentRound(db, redis, SETTINGS);
    await ensureCurrentRound(db, redis, SETTINGS);

    const [again] = await db.select().from(rounds).where(eq(rounds.id, ended));
    expect(again!.finalizedAt?.toISOString()).toBe(stamp?.toISOString());
    const frozenAgain = await db.select().from(roundEntries).where(eq(roundEntries.roundId, ended));
    expect(new Map(frozenAgain.map((r) => [r.playerId, r.finalExp])).get(a)).toBe(500n);
    expect(await payouts()).toHaveLength(3);
  });

  it("pays the awards in placing order, highest delta first", async () => {
    const ended = await seedRound("Placings", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const first = await seedPlayer("place_first", 900n);
    const second = await seedPlayer("place_second", 400n);
    for (const id of [first, second]) {
      await db.insert(roundEntries).values({ roundId: ended, playerId: id, expAtStart: 0n });
    }
    await ensureCurrentRound(db, redis, SETTINGS);

    const rows = await db.select().from(transactions)
      .where(and(eq(transactions.reason, "round.payout"), eq(transactions.refId, ended)));
    const byPlayer = new Map(rows.map((r) => [r.playerId, r.amount]));
    expect(byPlayer.get(first)).toBe(1000n);
    expect(byPlayer.get(second)).toBe(500n);
    expect(rows).toHaveLength(2);   // only two scorers, three awards
  });

  it("pays nobody when no entry scored a positive delta", async () => {
    const ended = await seedRound("Skipped", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const idle = await seedPlayer("idle_one", 50n);
    await db.insert(roundEntries).values({ roundId: ended, playerId: idle, expAtStart: 50n });
    await ensureCurrentRound(db, redis, SETTINGS);
    const rows = await db.select().from(transactions).where(eq(transactions.reason, "round.payout"));
    expect(rows).toEqual([]);
  });

  it("writes nothing at all for a live, already-snapshotted round", async () => {
    const live = await seedRound("Live", ago(60_000), ahead(3_600_000), { snapshottedAt: ago(60_000) });
    await seedPlayer("live_untouched", 10n);

    const active = await ensureCurrentRound(db, redis, SETTINGS);
    expect(active?.id).toBe(live);

    const [row] = await db.select().from(rounds).where(eq(rounds.id, live));
    expect(row!.finalizedAt).toBeNull();
    expect(await db.select().from(roundEntries)).toEqual([]);
    expect(await db.select().from(transactions)).toEqual([]);
  });

  it("returns null and writes nothing when there are no rounds", async () => {
    await seedPlayer("no_rounds", 0n);
    expect(await ensureCurrentRound(db, redis, SETTINGS)).toBeNull();
    expect(await db.select().from(roundEntries)).toEqual([]);
  });

  it("settles a chain of ended rounds in one call, oldest first", async () => {
    const first = await seedRound("Chain 1", ago(10_800_000), ago(7_200_000), { snapshottedAt: ago(10_800_000) });
    const second = await seedRound("Chain 2", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const live = await seedRound("Chain 3", ago(3_600_000), ahead(3_600_000));
    await seedPlayer("chain_player", 10n);

    const active = await ensureCurrentRound(db, redis, SETTINGS);
    expect(active?.id).toBe(live);
    for (const id of [first, second]) {
      const [row] = await db.select().from(rounds).where(eq(rounds.id, id));
      expect(row!.finalizedAt).not.toBeNull();
    }
    const [liveRow] = await db.select().from(rounds).where(eq(rounds.id, live));
    expect(liveRow!.snapshottedAt).not.toBeNull();
  });

  it("falls back to the default award table when the setting is unparseable", async () => {
    const ended = await seedRound("Bad Setting", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const winner = await seedPlayer("bad_setting_winner", 100n);
    await db.insert(roundEntries).values({ roundId: ended, playerId: winner, expAtStart: 0n });

    await ensureCurrentRound(db, redis, { "rounds.payout_points": "not json" });

    const [paid] = await db.select().from(transactions).where(eq(transactions.reason, "round.payout"));
    expect(paid!.amount).toBe(1000n);
  });

  it("notifies each winner without publishing a per-winner event", async () => {
    const ended = await seedRound("Notified", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const winner = await seedPlayer("notified_winner", 100n);
    await db.insert(roundEntries).values({ roundId: ended, playerId: winner, expAtStart: 0n });
    await ensureCurrentRound(db, redis, SETTINGS);

    const notes = await db.select().from(notifications).where(eq(notifications.playerId, winner));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("Notified");
    expect(notes[0]!.body).toContain("1000");
  });
});
