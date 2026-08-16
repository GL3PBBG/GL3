import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { notifications, players, playerStats, roundEntries, rounds, transactions }
  from "../src/db/schema/index.js";
import { ensureCurrentRound } from "../src/game/rounds/service.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { loadConfig } from "../src/config.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";

const { db } = testDb();
const config = loadConfig(process.env);
const redis = createRedis(config.redisUrl);
const subscriber = createSubscriber(config.redisUrl);
const SETTINGS = { "rounds.payout_points": "[1000,500,250]" };

/** Matches the lock `service.ts` takes inside `settle()` — see NOTES.md rule 6's neighbours. */
const ROUNDS_LOCK = 7461002;

afterAll(async () => { await redis.quit(); subscriber.disconnect(); });
beforeEach(async () => { await resetDb(db); });

/**
 * Races `promise` against a rejecting timer so a regression that makes the
 * fast path open a transaction (and so wait on `ROUNDS_LOCK`) fails the test
 * instead of hanging the whole suite.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

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

  it("takes the fast path for a live, already-snapshotted round — no transaction, no advisory lock wait", async () => {
    const live = await seedRound("Fast Path", ago(60_000), ahead(3_600_000), { snapshottedAt: ago(60_000) });
    await seedPlayer("fast_path_untouched", 10n);

    // A foreign session holds ROUNDS_LOCK for the whole call. If the fast
    // path regressed into always calling settle(), ensureCurrentRound would
    // block on `pg_advisory_xact_lock` behind this session and the call
    // below would time out instead of returning promptly.
    // `blocker.reserve()` is inside its own try, whose finally always ends
    // the pool — a rejecting reserve() before that finally existed leaked the
    // pool (blocker.end() never ran).
    const blocker = postgres(config.databaseUrl, { max: 1 });
    try {
      const t0 = await blocker.reserve();
      try {
        await t0`BEGIN`;
        await t0`SELECT pg_advisory_xact_lock(${ROUNDS_LOCK})`;

        const active = await withTimeout(
          ensureCurrentRound(db, redis, SETTINGS),
          2000,
          "ensureCurrentRound did not return within 2000ms while a foreign session held " +
            "the advisory lock — the fast path must not open a transaction",
        );
        expect(active?.id).toBe(live);
      } finally {
        await t0`ROLLBACK`;
        t0.release();
      }
    } finally {
      await blocker.end();
    }
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

  it("notifies each winner with the round name and payout amount", async () => {
    const ended = await seedRound("Notified", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const winner = await seedPlayer("notified_winner", 100n);
    await db.insert(roundEntries).values({ roundId: ended, playerId: winner, expAtStart: 0n });
    await ensureCurrentRound(db, redis, SETTINGS);

    const notes = await db.select().from(notifications).where(eq(notifications.playerId, winner));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("Notified");
    expect(notes[0]!.body).toContain("1000");
  });

  it("publishes round.finished for the settled round and round.started for its successor", async () => {
    const ended = await seedRound("Publishes Finished", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const next = await seedRound("Publishes Started", ago(60_000), ahead(3_600_000));
    const winner = await seedPlayer("publish_winner", 100n);
    await db.insert(roundEntries).values({ roundId: ended, playerId: winner, expAtStart: 0n });

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    // §4.4 sets `actorId` to the round's own id precisely so a test has a
    // per-round discriminator on a globally-audienced event — `game:events`
    // is shared with every other concurrently-running test file (NOTES.md
    // rule 4), so a bare `once("message")` could grab a stranger's payload.
    const finished = awaitOwnEvent(subscriber, ended);
    const started = awaitOwnEvent(subscriber, next);

    await ensureCurrentRound(db, redis, SETTINGS);

    // Promise.all, not two sequential awaits: each of these rejects on its
    // own 5s timeout (awaitOwnEvent's default), and awaiting them one after
    // the other leaves the second promise's rejection unhandled if the first
    // one is what fails — an unhandled rejection makes vitest exit non-zero
    // while still printing every test passed (NOTES.md).
    const [finishedEvent, startedEvent] = await Promise.all([finished, started]);
    expect(finishedEvent.type).toBe("round.finished");
    if (finishedEvent.type !== "round.finished") throw new Error("unreachable");
    expect(finishedEvent.roundId).toBe(ended);
    expect(finishedEvent.roundName).toBe("Publishes Finished");
    // The award PAID, as a decimal string — not the exp delta that earned it.
    expect(finishedEvent.winners).toEqual([
      { playerId: winner, username: "publish_winner", placing: 1, points: "1000" },
    ]);

    expect(startedEvent.type).toBe("round.started");
    if (startedEvent.type !== "round.started") throw new Error("unreachable");
    expect(startedEvent.roundId).toBe(next);
    expect(startedEvent.roundName).toBe("Publishes Started");
    expect(startedEvent.endsAt).not.toBeNull();
  });
});
