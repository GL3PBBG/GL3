import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InsufficientGangFundsError as SdkInsufficientGangFundsError } from "@gl3/plugin-sdk";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { gangLogs, gangs, players, playerStats, transactions } from "../src/db/schema/index.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { testDb } from "./helpers/db.js";

// testDb() returns createDb's { db, sql } pair, NOT a drizzle db — using it as
// one fails with `Cannot read properties of undefined (reading
// 'Symbol(drizzle:Columns)')`. There is no `testRedis` helper anywhere in this
// repo; Redis comes from createRedis(loadConfig(...).redisUrl), the shape
// test/bank.test.ts:13-15 already uses.
const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

beforeAll(async () => { await subscriber.subscribe(GAME_EVENTS_CHANNEL); });
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

// There is no test/helpers/factories.ts in this repo. Every existing test
// builds a player the way ledger.test.ts:18-19 does: a `players` row plus its
// `playerStats` row, which is where every balance actually lives.
async function createPlayer(cash = 0n): Promise<{ id: string; username: string }> {
  const id = uuidv7();
  // Whole uuid, not a prefix: uuidv7's leading hex is the millisecond
  // timestamp, so two players minted in the same tick collide on the
  // `players_username_unique` index.
  const username = `pctx${id}`;
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id, cash });
  return { id, username };
}

// Redis is shared across every concurrently-running test file; a shared
// `leaderboard:*` key would let two files see each other's scores.
const leaderboardPrefix = `ctxtx-test-${randomUUID()}`;

const deps = (): Parameters<typeof createPluginCtx>[0] =>
  ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix });
const opts = { pluginId: "t", player: null, job: null, filters: [] };

/**
 * `game:events` is a single global channel shared by every test file running in
 * parallel, so matching on event type alone captures another file's traffic
 * (CLAUDE.md rule 4). `awaitOwnEvent` filters by actorId; every player here is
 * freshly minted, so only this test's own publish can settle the promise.
 *
 * Local rather than the shared `awaitOwnEvent` helper because the rollback test
 * needs the *timeout* to be the success case, and needs to distinguish
 * "nothing arrived" from "the wait was abandoned".
 */
function watchOwnEvents(actorId: string): { seen: unknown[]; settled: Promise<void> } {
  const seen: unknown[] = [];
  let resolveFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const onMessage = (channel: string, raw: string): void => {
    if (channel !== GAME_EVENTS_CHANNEL) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return;
    if (!("actorId" in parsed) || parsed.actorId !== actorId) return;
    seen.push(parsed);
    resolveFirst();
  };
  subscriber.on("message", onMessage);
  const settled = Promise.race([first, new Promise<void>((r) => setTimeout(r, 750))])
    .then(() => { subscriber.off("message", onMessage); });
  return { seen, settled };
}

describe("ctx.transaction", () => {
  it("publishes a buffered event only after commit", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const watch = watchOwnEvents(player.id);

    await ctx.transaction(async (tx) => {
      await tx.events.publish({
        name: "greeted", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, payload: { times: "1" },
      });
    });

    await watch.settled;
    expect(watch.seen).toHaveLength(1);
    expect(watch.seen[0]).toMatchObject({
      type: "plugin.event", pluginId: "t", name: "greeted",
      actorId: player.id, actorName: player.username,
      audience: { kind: "global" }, payload: { times: "1" },
    });
  });

  it("drops buffered events when the transaction rolls back", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const watch = watchOwnEvents(player.id);

    await expect(ctx.transaction(async (tx) => {
      await tx.events.publish({
        name: "greeted", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, payload: {},
      });
      throw new Error("boom");
    })).rejects.toThrow("boom");

    await watch.settled;
    expect(watch.seen).toEqual([]);
  });

  it("moves money through the ledger, never by a bare update", async () => {
    const player = await createPlayer(1000n);
    const ctx = createPluginCtx(deps(), opts);

    const after = await ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      return await tx.economy.applyBalanceChange({
        playerId: player.id, amount: -250n, kind: "cash", reason: "plugin_test",
      });
    });

    expect(after).toBe(750n);
    const rows = await db.select().from(transactions).where(eq(transactions.playerId, player.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: -250n, balanceKind: "cash", reason: "plugin_test" });
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, player.id));
    expect(row?.cash).toBe(750n);
  });

  it("rolls the ledger row back with the transaction", async () => {
    const player = await createPlayer(1000n);
    const ctx = createPluginCtx(deps(), opts);

    await expect(ctx.transaction(async (tx) => {
      await tx.economy.applyBalanceChange({
        playerId: player.id, amount: -250n, kind: "cash", reason: "plugin_test",
      });
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(await db.select().from(transactions).where(eq(transactions.playerId, player.id))).toHaveLength(0);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, player.id));
    expect(row?.cash).toBe(1000n);
  });

  // Covers the surfaces whose SDK types had to be reshaped to match core:
  // PluginGangBalanceChange carries `kind` (core needs it to pick the
  // gangs.cash vs gangs.bank column) and GangLogEntry mirrors appendGangLog's
  // three positional parameters. A pass-through that compiles but transposes
  // an argument would still be green without this.
  it("moves gang money, appends a gang log, and locks both sides in one order", async () => {
    const player = await createPlayer();
    const gangId = uuidv7();
    await db.insert(gangs).values({ id: gangId, name: `g${gangId.slice(0, 8)}`, bank: 500n });
    const ctx = createPluginCtx(deps(), opts);

    const after = await ctx.transaction(async (tx) => {
      await tx.locks.gangAndPlayer(gangId, player.id);
      const balance = await tx.economy.applyGangBalanceChange({
        gangId, amount: -125n, kind: "bank", reason: "plugin_gang_test",
      });
      await tx.gangLog({ gangId, playerId: player.id, message: "plugin withdrew 125" });
      return balance;
    });

    expect(after).toBe(375n);
    const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
    expect(gang?.bank).toBe(375n);
    const logs = await db.select().from(gangLogs).where(eq(gangLogs.gangId, gangId));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ gangId, playerId: player.id, message: "plugin withdrew 125" });
  });

  // The gap the bank port deferred: without the ctx wrap, core's own
  // InsufficientGangFundsError escapes the loader's PluginError catch as an
  // unrecognised error and Fastify answers 500, where core's withdraw route
  // answered 400 insufficient_gang_funds (game/gangs/routes.ts:833). A plugin
  // package cannot import core's class, so the only way a ported gangs plugin
  // can catch this is if the ctx translates it into the SDK one on the way out.
  it("translates a gang overdraft into the SDK's InsufficientGangFundsError", async () => {
    const gangId = uuidv7();
    // Whole uuid, not a prefix, for the same reason createPlayer's username
    // is: uuidv7's leading hex is the millisecond timestamp truncated to a
    // ~65s bucket, so an 8-char slice collides with the "moves gang money"
    // case above when both run in the same file within that window.
    await db.insert(gangs).values({ id: gangId, name: `g${gangId}`, bank: 100n });
    const ctx = createPluginCtx(deps(), opts);

    const thrown = await ctx.transaction(async (tx) => {
      try {
        await tx.economy.applyGangBalanceChange({
          gangId, amount: -500n, kind: "bank", reason: "plugin_gang_overdraft_test",
        });
        return null;
      } catch (error) {
        return error;
      }
    });

    expect(thrown).toBeInstanceOf(SdkInsufficientGangFundsError);
    expect(thrown).toMatchObject({ gangId, kind: "bank" });
    // The balance is untouched: applyGangBalanceChange refuses before writing.
    const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
    expect(gang?.bank).toBe(100n);
  });

  it("reads settings under the plugin's own prefix and nowhere else", async () => {
    const ctx = createPluginCtx(
      { db, redis, queues: new Map(), settings: { "t.greeting": "hi", "other.greeting": "no" }, leaderboardPrefix },
      opts,
    );
    expect(ctx.settings.get("greeting")).toBe("hi");
    expect(ctx.settings.get("missing")).toBeNull();
  });
});
