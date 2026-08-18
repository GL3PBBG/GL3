import type { FastifyInstance, InjectOptions } from "fastify";
import type { Redis } from "ioredis";
import type { LightMyRequestResponse } from "light-my-request";
import { and, eq, isNotNull } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GameEventSchema, type GameEvent } from "@gl3/shared";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { players, playerStats, roundEntries, rounds, settings, transactions } from "../src/db/schema/index.js";
import { loadConfig } from "../src/config.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * §5.2 / §5.6: N concurrent callers must settle a rollover exactly once. This
 * is the HTTP form — `GET /api/rounds` shipped in the routes task, so this
 * drives 8 concurrent `app.inject()` calls rather than `ensureCurrentRound`
 * directly. See `service.ts`'s `ROUNDS_LOCK` / `settle()` for the mechanism
 * under test: the advisory lock is what turns 8 racing settles into one
 * settle plus 7 no-ops, instead of 8 finalizes that each freeze-and-pay before
 * any of them reaches the guarded `finalized_at` stamp.
 */

const { db, sql: conn } = testDb();
const config = loadConfig({ ...process.env, NODE_ENV: "test" });
const subscriber = createSubscriber(config.redisUrl);

// Deliberately NOT the default [1000n, 500n, 250n] in any position, so a
// silent fallback to the default award table (e.g. because this setting was
// seeded after boot, or never read) cannot masquerade as a correct run.
const AWARD_POINTS: readonly bigint[] = [900n, 600n, 300n];

const CALLERS = 8;

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

const ago = (ms: number): Date => new Date(Date.now() - ms);
const ahead = (ms: number): Date => new Date(Date.now() + ms);

function fire(opts: InjectOptions): Promise<LightMyRequestResponse> {
  // app.inject() is lazy — it dispatches only when something calls .then.
  // Promise.resolve schedules that immediately, which is what puts all 8
  // requests genuinely in flight together rather than serialised on await.
  return Promise.resolve(app.inject(opts));
}

async function register(): Promise<{ token: string }> {
  return registerVerifiedPlayer({ app, redis }, { username: `rollover_${Date.now() % 1_000_000}` });
}

async function seedPlayer(username: string, exp: bigint): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id, exp });
  return id;
}

async function seedRound(
  name: string,
  startsAt: Date | null,
  endsAt: Date | null,
  stamps?: { snapshottedAt?: Date },
): Promise<string> {
  const id = uuidv7();
  await db.insert(rounds).values({ id, name, startsAt, endsAt, snapshottedAt: stamps?.snapshottedAt ?? null });
  return id;
}

beforeAll(async () => {
  await resetDb(db);
  // Settings are read once at boot into a plain record (settings/load.ts),
  // so this row must exist BEFORE bootTestServer() calls buildApp().
  await db.insert(settings).values({
    key: "rounds.payout_points",
    value: JSON.stringify(AWARD_POINTS.map((n) => n.toString())),
  });
  ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
  subscriber.disconnect();
});

describe("rollover fires exactly once under concurrency", () => {
  it("8 concurrent GET /api/rounds settle the ended round exactly once", async () => {
    const ended = await seedRound("Concurrency Ended", ago(7_200_000), ago(3_600_000), {
      snapshottedAt: ago(7_200_000),
    });
    // Successor's starts_at equals the ended round's ends_at, and BOTH are in
    // the past — otherwise finalize's re-evaluation never matches the
    // successor, no activation happens, and assertions 4-5 fail for a reason
    // unrelated to the race under test.
    const successor = await seedRound("Concurrency Successor", ago(3_600_000), ahead(3_600_000));

    // Four players, distinct exp, one below the three-award cutoff so it has
    // a non-placer to ignore.
    const first = await seedPlayer("rollover_first", 950n);
    const second = await seedPlayer("rollover_second", 700n);
    const third = await seedPlayer("rollover_third", 400n);
    const fourth = await seedPlayer("rollover_fourth", 100n);
    for (const id of [first, second, third, fourth]) {
      await db.insert(roundEntries).values({ roundId: ended, playerId: id, expAtStart: 0n });
    }

    const { token } = await register();
    const auth = { authorization: `Bearer ${token}` };

    // Collector: every frame whose actorId is the ended round's id or the
    // successor's id (rule 4 — game:events is global across every
    // concurrently-running test file). awaitOwnEvent below resolves on the
    // FIRST matching frame; this handler is what lets assertion 6 count them
    // all rather than just prove one arrived.
    const finishedFrames: GameEvent[] = [];
    const startedFrames: GameEvent[] = [];
    function onMessage(channel: string, raw: string): void {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      if (parsed.data.actorId !== ended && parsed.data.actorId !== successor) return;
      if (parsed.data.type === "round.finished") finishedFrames.push(parsed.data);
      if (parsed.data.type === "round.started") startedFrames.push(parsed.data);
    }
    subscriber.on("message", onMessage);
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);

    const finishedArrived = awaitOwnEvent(subscriber, ended);
    const startedArrived = awaitOwnEvent(subscriber, successor);

    const results = await Promise.all(
      Array.from({ length: CALLERS }, () => fire({ method: "GET", url: "/api/rounds", headers: auth })),
    );

    // Both events are published (inside ensureCurrentRound, before the HTTP
    // response is sent) well before Promise.all above resolves, but delivery
    // over the pub/sub connection is still an async network hop — wait for it
    // explicitly rather than assuming it already landed. Promise.all, not two
    // sequential awaits: each of these rejects on its own 5s timeout
    // (awaitOwnEvent's default), and a sequential await leaves the second
    // promise's rejection unhandled if the first one is what fails — an
    // unhandled rejection makes vitest exit non-zero while still printing
    // every test passed (CLAUDE.md).
    await Promise.all([finishedArrived, startedArrived]);
    subscriber.off("message", onMessage);

    // 1. all 8 calls resolve cleanly — none throws, no 23505.
    for (const res of results) {
      expect(res.body, `body: ${res.body}`).not.toContain("23505");
      expect(res.statusCode, `status ${res.statusCode}, body: ${res.body}`).toBe(200);
    }

    // 2. exactly one row in rounds has a non-null finalized_at, and it is the
    // ended round.
    const finalizedRows = await db.select().from(rounds).where(isNotNull(rounds.finalizedAt));
    expect(finalizedRows).toHaveLength(1);
    expect(finalizedRows[0]!.id).toBe(ended);

    // 3. exactly one payout per award, not a multiple of it — the assertion a
    // second finalize breaks.
    const payouts = await db.select().from(transactions)
      .where(and(eq(transactions.reason, "round.payout"), eq(transactions.refId, ended)));
    expect(payouts).toHaveLength(AWARD_POINTS.length);
    const byPlayer = new Map(payouts.map((p) => [p.playerId, p.amount]));
    expect(byPlayer.get(first)).toBe(AWARD_POINTS[0]);
    expect(byPlayer.get(second)).toBe(AWARD_POINTS[1]);
    expect(byPlayer.get(third)).toBe(AWARD_POINTS[2]);
    expect(byPlayer.has(fourth)).toBe(false);

    // 4. round_entries for the successor holds exactly one row per player
    // (the 4 seeded plus the registered caller), and its snapshotted_at is set.
    const successorEntries = await db.select().from(roundEntries).where(eq(roundEntries.roundId, successor));
    expect(successorEntries).toHaveLength(5);
    const [successorRow] = await db.select().from(rounds).where(eq(rounds.id, successor));
    expect(successorRow!.snapshottedAt).not.toBeNull();

    // 5. every players.round_id equals the successor's id.
    const allPlayers = await db.select({ roundId: players.roundId }).from(players);
    expect(allPlayers).toHaveLength(5);
    for (const row of allPlayers) expect(row.roundId).toBe(successor);

    // 6. exactly one round.finished and exactly one round.started — a second
    // publish is the observable symptom of a double-finalize, and the one that
    // would reach every connected client.
    expect(finishedFrames).toHaveLength(1);
    expect(startedFrames).toHaveLength(1);
    expect(finishedFrames[0]!.actorId).toBe(ended);
    expect(startedFrames[0]!.actorId).toBe(successor);
  }, 30_000);
});
