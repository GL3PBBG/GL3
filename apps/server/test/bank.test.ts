import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, playerStats, transactions } from "../src/db/schema/index.js";
import bankPlugin from "@gl3/plugin-bank";
import { PluginError } from "@gl3/plugin-sdk";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { callPluginRoute } from "./helpers/plugin-route.js";
import { registerVerifiedPlayer } from "./helpers/register.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let playerId: string;

// This file drives the plugin handler directly (no bootTestServer), so
// nothing namespaces its leaderboard writes automatically — pass a run-unique
// prefix so it never zadd's into the shared `leaderboard:*` keys other
// concurrent test files and agents read.
const leaderboardPrefix = `bank-test-${uuidv7()}`;

/** The bank plugin's own route, driven in-process. See helpers/plugin-route.ts. */
async function bank(
  direction: "deposit" | "withdraw",
  amount: bigint,
): Promise<{ cash: bigint; bank: bigint }> {
  const result = await callPluginRoute(bankPlugin, "POST", `/api/bank/${direction}`, {
    db, redis, leaderboardPrefix, playerId, body: { amount: amount.toString() },
  });
  const body = result.body as { cash: string; bank: string };
  return { cash: BigInt(body.cash), bank: BigInt(body.bank) };
}

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n });
});
afterAll(async () => {
  // Best-effort: only ever removes this run's own namespaced keys.
  await redis.del(`${leaderboardPrefix}:cash`, `${leaderboardPrefix}:bank`);
  await conn.end(); redis.disconnect(); subscriber.disconnect();
});

describe("bank plugin routes", () => {
  it("moves cash into the bank in one transaction with two ledger rows", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    // `game:events` is a global channel shared by every test file running in
    // parallel — a bare `once("message")` resolves on whichever file's event
    // lands first and can grab someone else's payload. Filter on this test's
    // own actor.
    const received = awaitOwnEvent(subscriber, playerId);

    expect(await bank("deposit", 400n)).toEqual({ cash: 600n, bank: 400n });

    const event = await received;
    expect(event.type).toBe("bank.transacted");
    if (event.type !== "bank.transacted") throw new Error("unreachable");
    expect(event.direction).toBe("deposit");
    expect(event.amount).toBe("400");
    // Bank state is NOT broadcast. The field most easily got wrong by copying
    // the news port, whose audience is { kind: "global" }.
    expect(event.audience).toEqual({ kind: "player", playerId });

    const ledger = await db.select().from(transactions).orderBy(transactions.balanceKind);
    expect(ledger).toHaveLength(2);
    expect(ledger.find((r) => r.balanceKind === "cash")?.amount).toBe(-400n);
    expect(ledger.find((r) => r.balanceKind === "bank")?.amount).toBe(400n);
  });

  it("moves bank cash back to cash on withdraw", async () => {
    await bank("deposit", 400n);
    expect(await bank("withdraw", 150n)).toEqual({ cash: 750n, bank: 250n });
  });

  it("rejects an overdraft on either leg and leaves both balances untouched", async () => {
    // Not a bare `.rejects.toThrow()`: that would pass on any error, including
    // the 500-shaped one this port exists to rule out.
    await expect(bank("withdraw", 1n)).rejects.toBeInstanceOf(PluginError);
    await expect(bank("withdraw", 1n)).rejects.toMatchObject({
      code: "insufficient_funds", status: 409,
    });
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.cash).toBe(1000n);
    expect(row?.bank).toBe(0n);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it("serializes two concurrent withdrawals so only one can succeed against a tight balance", async () => {
    await bank("deposit", 100n);
    const results = await Promise.allSettled([
      bank("withdraw", 60n),
      bank("withdraw", 60n),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [row] = await db.select({ bank: playerStats.bank }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.bank).toBe(40n);
  });
});

describe("POST /api/bank/deposit and /withdraw", () => {
  it("deposits, withdraws, and rejects an overdraft over HTTP", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadPlugins } = await import("../src/plugins/loader.js");
    const { withCorePlugins } = await import("../src/plugins/core-plugins.js");

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const loadedPlugins = await loadPlugins(
      { db, redis, settings: {}, leaderboardPrefix },
      withCorePlugins([]),
      `plugin-bank-test-${uuidv7()}-`,
    );
    const app = await buildApp(config, { db, redis, leaderboardPrefix, plugins: loadedPlugins });
    const { token, playerId: registeredId } = await registerVerifiedPlayer({ app, redis }, { username: `Bank${Date.now()}` });
    // registration starts a player at 0 cash — fund them directly so the
    // deposit below has something to move.
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, registeredId));

    const deposit = await app.inject({
      method: "POST", url: "/api/bank/deposit",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: "300" },
    });
    expect(deposit.statusCode).toBe(200);
    expect(deposit.json()).toEqual({ cash: "700", bank: "300" });

    const withdraw = await app.inject({
      method: "POST", url: "/api/bank/withdraw",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: "100" },
    });
    expect(withdraw.statusCode).toBe(200);
    expect(withdraw.json()).toEqual({ cash: "800", bank: "200" });

    const overdraft = await app.inject({
      method: "POST", url: "/api/bank/withdraw",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: "999999" },
    });
    expect(overdraft.statusCode).toBe(409);
    expect(overdraft.json()).toEqual({ error: "insufficient_funds" });

    const zero = await app.inject({
      method: "POST", url: "/api/bank/deposit",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: "0" },
    });
    expect(zero.statusCode).toBe(400);

    const negative = await app.inject({
      method: "POST", url: "/api/bank/deposit",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: "-50" },
    });
    expect(negative.statusCode).toBe(400);

    const unauthenticated = await app.inject({ method: "POST", url: "/api/bank/deposit", payload: { amount: "10" } });
    expect(unauthenticated.statusCode).toBe(401);

    await app.close();
    for (const w of loadedPlugins.workers) await w.close();
    for (const q of loadedPlugins.queues.values()) await q.close();
  });
});
